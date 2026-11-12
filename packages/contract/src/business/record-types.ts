/**
 * Record types — the kinds a workspace defines for itself (`account`,
 * `contact`, `deal`, `zone`…) and the field values their records carry.
 *
 * Who uses it: the API validates every record write with the zod schema
 * `buildRecordFieldsSchema` builds from a definition (REST, MCP and the
 * ingest API alike); the web will build its forms from the same definitions
 * (PR4). `brief` prints `compactRecordTypes` so an agent knows what exists
 * without another call.
 *
 * The model, in short:
 *   - A record type with `storage: "node"` IS a node kind. To an agent it is
 *     `kind: "account"`, never `entity` plus a subtype. The kinds valid in a
 *     workspace are `NODE_KINDS` plus its node record type keys
 *     (`isValidKindFor`); Postgres repeats the rule in a trigger (0103).
 *   - Field values live in `node.data.fields`, keyed by field key. A
 *     pipeline stage is a `select` field named by `stage_field` — never the
 *     core `status` column, whose vocabulary is fixed and drives views.
 *   - `storage: "dataset"` records are rows of a dataset node, keyed by the
 *     sender's external id: people in a B2C business are too many and too
 *     personal to be nodes. They can be promoted to a node record later.
 *
 * What must not break: a key that collides with a core kind (the DB refuses
 * it too), and error messages that name the offending field — an agent fixes
 * a write from the message alone.
 */
import { z } from "zod";
import { NODE_KINDS, isCoreKind } from "../types.js";

/* -------------------------------------------------------------------------- */
/*  Business model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What kind of business the workspace is. `product` is a software team with
 * no business metrics — the default, and what every workspace was before.
 * `b2b`/`b2c` subscription businesses get the SaaS KPI set; `marketplace`
 * gets GMV, take and liquidity.
 */
export const BUSINESS_MODELS = ["product", "b2b", "b2c", "marketplace"] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export function isBusinessModel(value: unknown): value is BusinessModel {
  return typeof value === "string" && (BUSINESS_MODELS as readonly string[]).includes(value);
}

/** ISO 4217, upper case. No list: validating the shape is enough without FX. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code such as EUR");

/** `PATCH /api/workspaces/:ws/business` body, and admin_write(op=set_business). */
export const BusinessSettingsPatchSchema = z.object({
  business_model: z.enum(BUSINESS_MODELS).optional(),
  currency: CurrencySchema.optional(),
}).strict();
export type BusinessSettingsPatch = z.infer<typeof BusinessSettingsPatchSchema>;

export interface BusinessSettings {
  business_model: BusinessModel;
  currency: string;
}

/* -------------------------------------------------------------------------- */
/*  Definitions                                                               */
/* -------------------------------------------------------------------------- */

/** Same shape as the DB check (0103): it becomes a `kind`, so slug-like. */
export const RECORD_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const RECORD_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const RECORD_FIELD_TYPES = [
  "text",
  "number",
  "money",
  "date",
  "boolean",
  "select",
  "multi_select",
  "url",
  "email",
  "person",
  "relation",
] as const;
export type RecordFieldType = (typeof RECORD_FIELD_TYPES)[number];

/**
 * Field types a dataset-backed record type may use: the ones a dataset cell
 * can hold (text, number, boolean, date — `datasets.ts`). Money, lists and
 * relations would need a column per part or a cell that is not a cell; a
 * person record in a B2C dataset does not need them, and a record that does
 * is a node.
 */
export const DATASET_RECORD_FIELD_TYPES = ["text", "number", "date", "boolean", "select", "url", "email", "person"] as const;

/** The dataset column type a field is stored as when its record type is dataset-backed. */
export function datasetColumnTypeFor(type: RecordFieldType): "text" | "number" | "boolean" | "date" {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    default:
      return "text";
  }
}

export const RECORD_STORAGES = ["node", "dataset"] as const;
export type RecordStorage = (typeof RECORD_STORAGES)[number];

export const RECORD_LIMITS = {
  maxFields: 50,
  maxOptions: 100,
  maxTextLength: 10_000,
  maxRelationIds: 100,
  maxRecordTypes: 50,
} as const;

/**
 * Keys a record's `data` reserves for the system. A `data` patch that drops
 * them is re-applied by the API: losing `external_id` would make the next
 * ingest create a duplicate instead of updating.
 */
export const RECORD_RESERVED_DATA_KEYS = ["fields", "external_id", "source_row"] as const;

export interface RecordFieldDef {
  key: string;
  label: string;
  type: RecordFieldType;
  required?: boolean;
  /** select / multi_select: the allowed values, in order (stages, for a stage field). */
  options?: string[];
  /** relation: a record type key or a core kind the ids must point at. */
  target?: string;
  /** relation: true when the value is a list of ids. */
  multiple?: boolean;
  /** One line. It is what the agent reads to decide what goes here. */
  description?: string;
}

/** What `record_types.definition` holds, plus the columns, as one object. */
export interface RecordTypeDefinition {
  key: string;
  label: string;
  label_plural?: string | null;
  description?: string | null;
  storage: RecordStorage;
  /** storage=dataset: the `data` node whose rows hold the records. */
  dataset_node_id?: string | null;
  fields: RecordFieldDef[];
  /** A `select` field whose options are the pipeline stages, in order. */
  stage_field?: string | null;
}

/** A stored record type, as the API returns it. */
export interface RecordType extends RecordTypeDefinition {
  id: string;
  workspace_id: string;
  position: number;
  created_at: string;
  updated_at: string;
}

const FieldDefSchema = z.object({
  key: z.string().regex(RECORD_FIELD_KEY_PATTERN, "field key must be lowercase letters, digits and _ (start with a letter, ≤ 40)"),
  label: z.string().trim().min(1).max(80),
  type: z.enum(RECORD_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(RECORD_LIMITS.maxOptions).optional(),
  target: z.string().min(1).max(40).optional(),
  multiple: z.boolean().optional(),
  description: z.string().trim().max(200).optional(),
}).strict().superRefine((field, ctx) => {
  const choice = field.type === "select" || field.type === "multi_select";
  if (choice && (!field.options || field.options.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["options"], message: `field \`${field.key}\` is a ${field.type} and needs options` });
  }
  if (!choice && field.options) {
    ctx.addIssue({ code: "custom", path: ["options"], message: `field \`${field.key}\` is a ${field.type}; only select fields take options` });
  }
  if (choice && field.options && new Set(field.options).size !== field.options.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: `field \`${field.key}\` repeats an option` });
  }
  if (field.type === "relation" && !field.target) {
    ctx.addIssue({ code: "custom", path: ["target"], message: `field \`${field.key}\` is a relation and needs a target (a record type key or a core kind)` });
  }
  if (field.type !== "relation" && (field.target || field.multiple !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["target"], message: `field \`${field.key}\`: only relation fields take target/multiple` });
  }
});

/**
 * Creating a record type. Cross-checks that need the workspace (relation
 * targets exist, the dataset node exists and is a `data` node, the key is
 * free) are the API's; everything decidable from the definition alone is here.
 */
export const RecordTypeInputSchema = z.object({
  key: z.string().regex(RECORD_TYPE_KEY_PATTERN, "key must be 2-40 chars: lowercase letters, digits and _, starting with a letter"),
  label: z.string().trim().min(1).max(80),
  label_plural: z.string().trim().min(1).max(80).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  storage: z.enum(RECORD_STORAGES).default("node"),
  dataset_node_id: z.string().min(1).nullable().optional(),
  fields: z.array(FieldDefSchema).max(RECORD_LIMITS.maxFields).default([]),
  stage_field: z.string().min(1).nullable().optional(),
}).strict().superRefine((def, ctx) => checkDefinition(def, ctx));

/** Updating one: everything but `key` and `storage`, which are identity. */
export const RecordTypePatchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  label_plural: z.string().trim().min(1).max(80).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  fields: z.array(FieldDefSchema).max(RECORD_LIMITS.maxFields).optional(),
  stage_field: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
}).strict();

export type RecordTypeInput = z.input<typeof RecordTypeInputSchema>;
export type RecordTypePatch = z.infer<typeof RecordTypePatchSchema>;

function checkDefinition(
  def: Pick<RecordTypeDefinition, "key" | "storage" | "dataset_node_id" | "fields" | "stage_field">,
  ctx: z.RefinementCtx,
): void {
  if (isCoreKind(def.key)) {
    ctx.addIssue({
      code: "custom",
      path: ["key"],
      message: `\`${def.key}\` is a core kind; record type keys must not be one of ${NODE_KINDS.join(", ")}`,
    });
  }
  if (def.storage === "dataset" && !def.dataset_node_id) {
    ctx.addIssue({ code: "custom", path: ["dataset_node_id"], message: "storage=dataset needs dataset_node_id (a `data` node)" });
  }
  if (def.storage === "node" && def.dataset_node_id) {
    ctx.addIssue({ code: "custom", path: ["dataset_node_id"], message: "dataset_node_id is only for storage=dataset" });
  }
  if (def.storage === "dataset") {
    for (const field of def.fields) {
      if (!(DATASET_RECORD_FIELD_TYPES as readonly string[]).includes(field.type)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields"],
          message: `field \`${field.key}\` is a ${field.type}; a dataset-backed type takes ${DATASET_RECORD_FIELD_TYPES.join(", ")}`,
        });
      }
      if (field.key === "external_id") {
        ctx.addIssue({ code: "custom", path: ["fields"], message: "`external_id` is the row key column of a dataset-backed type; do not declare it as a field" });
      }
    }
  }
  const seen = new Set<string>();
  for (const field of def.fields) {
    if (seen.has(field.key)) {
      ctx.addIssue({ code: "custom", path: ["fields"], message: `field key \`${field.key}\` appears twice` });
    }
    seen.add(field.key);
  }
  if (def.stage_field) {
    const stage = def.fields.find((field) => field.key === def.stage_field);
    if (!stage || stage.type !== "select") {
      ctx.addIssue({
        code: "custom",
        path: ["stage_field"],
        message: `stage_field \`${def.stage_field}\` must name a select field of this type; its options are the stages`,
      });
    }
  }
}

/**
 * Re-check a definition after a patch is merged onto it: the patch schema
 * cannot see the fields it does not carry, so "stage_field names a select
 * field" has to be asked of the result.
 */
export function definitionIssues(def: RecordTypeDefinition): string[] {
  const issues: string[] = [];
  const result = z.object({}).passthrough().superRefine((_value, ctx) => checkDefinition(def, ctx)).safeParse({});
  if (!result.success) for (const issue of result.error.issues) issues.push(issue.message);
  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                     */
/* -------------------------------------------------------------------------- */

/** The kinds a workspace's nodes may carry: core kinds plus node record types. */
export function validKindsFor(recordTypes: readonly Pick<RecordTypeDefinition, "key" | "storage">[]): string[] {
  return [...NODE_KINDS, ...recordTypes.filter((type) => type.storage === "node").map((type) => type.key)];
}

export function isValidKindFor(
  kind: string,
  recordTypes: readonly Pick<RecordTypeDefinition, "key" | "storage">[],
): boolean {
  return isCoreKind(kind) || recordTypes.some((type) => type.storage === "node" && type.key === kind);
}

/**
 * The error a write with an unknown kind gets: it names what does exist, so
 * the next call can be right.
 */
export function unknownKindMessage(
  kind: string,
  recordTypes: readonly Pick<RecordTypeDefinition, "key" | "storage">[],
): string {
  const custom = recordTypes.filter((type) => type.storage === "node").map((type) => type.key);
  return `unknown kind \`${kind}\`. Core kinds: ${NODE_KINDS.join(", ")}` +
    (custom.length ? `; this workspace's record types: ${custom.join(", ")}` : "; this workspace defines no record types");
}

/* -------------------------------------------------------------------------- */
/*  Field values                                                              */
/* -------------------------------------------------------------------------- */

export interface MoneyValue {
  amount: number;
  currency: string;
}

export type RecordFieldValue = string | number | boolean | string[] | MoneyValue | null;
export type RecordFields = Record<string, RecordFieldValue>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueSchema(field: RecordFieldDef): z.ZodTypeAny {
  switch (field.type) {
    case "text":
      return z.string().max(RECORD_LIMITS.maxTextLength, `at most ${RECORD_LIMITS.maxTextLength} characters`);
    case "number":
      return z.number({ invalid_type_error: "expected a number" }).finite();
    case "money":
      return z.object({
        amount: z.number({ invalid_type_error: "amount must be a number" }).finite(),
        currency: CurrencySchema,
      }, { invalid_type_error: "expected {amount, currency}" }).strict();
    case "date":
      return z.string({ invalid_type_error: "expected a date (YYYY-MM-DD or ISO timestamp)" }).refine(
        (value) => (ISO_DATE.test(value) || value.includes("T")) && !Number.isNaN(Date.parse(value)),
        "expected a date (YYYY-MM-DD or ISO timestamp)",
      );
    case "boolean":
      return z.boolean({ invalid_type_error: "expected true or false" });
    case "select":
      return z.enum(field.options as [string, ...string[]], {
        errorMap: () => ({ message: `expected one of ${(field.options ?? []).join(" | ")}` }),
      });
    case "multi_select":
      return z.array(z.enum(field.options as [string, ...string[]], {
        errorMap: () => ({ message: `values must be among ${(field.options ?? []).join(" | ")}` }),
      })).refine((values) => new Set(values).size === values.length, "repeats a value");
    case "url":
      return z.string().url("expected a URL").refine((value) => /^https?:\/\//i.test(value), "expected an http(s) URL");
    case "email":
      return z.string().email("expected an email address");
    case "person":
      return z.string().regex(UUID, "expected a user id (uuid)");
    case "relation": {
      const id = z.string().min(1, "expected a node id").max(200);
      return field.multiple
        ? z.array(id, { invalid_type_error: "expected a list of node ids" }).max(RECORD_LIMITS.maxRelationIds)
        : id;
    }
  }
}

/**
 * The zod schema for a record's `fields`, built from its type.
 *
 * `mode: "create"` demands required fields; `"patch"` validates only what
 * is sent (a missing key keeps its value) but still refuses `null` on a
 * required one. Unknown keys are refused in both: a typo that silently
 * created a new field is how `mmr` ends up beside `mrr`.
 */
export function buildRecordFieldsSchema(
  def: Pick<RecordTypeDefinition, "fields">,
  mode: "create" | "patch" = "create",
): z.ZodType<RecordFields> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of def.fields) {
    let schema = valueSchema(field);
    if (!field.required) schema = schema.nullable();
    if (mode === "patch" || !field.required) schema = schema.optional();
    shape[field.key] = schema;
  }
  return z.object(shape).strict() as unknown as z.ZodType<RecordFields>;
}

export interface RecordFieldIssue {
  field: string | null;
  message: string;
}

export type RecordFieldsResult =
  | { ok: true; fields: RecordFields }
  | { ok: false; issues: RecordFieldIssue[]; message: string };

/**
 * Validate `fields` against a record type and return either the clean value
 * or issues that each name a field. The joined `message` is what the REST,
 * MCP and ingest surfaces return verbatim.
 */
export function validateRecordFields(
  def: Pick<RecordTypeDefinition, "key" | "fields">,
  input: unknown,
  mode: "create" | "patch" = "create",
): RecordFieldsResult {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const issue = { field: null, message: "`fields` must be an object of field key → value" };
    return { ok: false, issues: [issue], message: issue.message };
  }
  const parsed = buildRecordFieldsSchema(def, mode).safeParse(value);
  if (parsed.success) return { ok: true, fields: parsed.data };
  const known = def.fields.map((field) => field.key);
  const issues: RecordFieldIssue[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({
          field: key,
          message: `\`${key}\` is not a field of ${def.key}` + (known.length ? ` (fields: ${known.join(", ")})` : " (it has no fields)"),
        });
      }
      continue;
    }
    const field = typeof issue.path[0] === "string" ? issue.path[0] : null;
    const message = issue.code === "invalid_type" && issue.received === "undefined"
      ? "is required"
      : issue.message;
    issues.push({ field, message: field ? `field \`${field}\`: ${message}` : message });
  }
  return { ok: false, issues, message: `invalid fields for ${def.key}: ${issues.map((i) => i.message).join("; ")}` };
}

/** `node.data.fields`, defensively: whatever is stored, an object comes back. */
export function readRecordFields(data: unknown): RecordFields {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const fields = (data as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  return fields as RecordFields;
}

/* -------------------------------------------------------------------------- */
/*  Field filters (nodes op=list)                                             */
/* -------------------------------------------------------------------------- */

/**
 * The filter language for record fields: deliberately five operators. It is
 * applied in memory over the listed nodes (the reach filter already is), by
 * `nodes(op=list)` and by saved views (`query.field_filters`).
 *
 * `empty` takes a boolean: `true` keeps records with no value (missing, null,
 * "" or []), `false` keeps the ones that have one — "deals without a close
 * date" is a question a pipeline review asks every week.
 */
export const RECORD_FIELD_OPERATORS = ["eq", "in", "gt", "lt", "empty"] as const;
export type RecordFieldOperator = (typeof RECORD_FIELD_OPERATORS)[number];

export const RecordFieldFilterSchema = z.object({
  field: z.string().regex(RECORD_FIELD_KEY_PATTERN),
  op: z.enum(RECORD_FIELD_OPERATORS),
  value: z.unknown(),
}).strict();
export type RecordFieldFilter = z.infer<typeof RecordFieldFilterSchema>;

function comparable(value: unknown): number | string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value) && "amount" in (value as object)) {
    const amount = (value as { amount?: unknown }).amount;
    return typeof amount === "number" ? amount : null;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return null;
}

/**
 * Does one record match every filter? Money compares on its amount, dates
 * compare as ISO strings (which order correctly), a multi-value field
 * matches `eq` when it contains the value.
 */
export function matchesFieldFilters(fields: RecordFields, filters: readonly RecordFieldFilter[]): boolean {
  return filters.every((filter) => {
    const raw = fields[filter.field];
    if (filter.op === "empty") {
      const isEmpty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
      return filter.value === false ? !isEmpty : isEmpty;
    }
    if (Array.isArray(raw)) {
      if (filter.op === "eq") return raw.includes(filter.value as string);
      if (filter.op === "in") return Array.isArray(filter.value) && raw.some((v) => (filter.value as unknown[]).includes(v));
      return false;
    }
    const left = comparable(raw);
    switch (filter.op) {
      case "eq":
        return left === comparable(filter.value);
      case "in":
        return Array.isArray(filter.value) && filter.value.some((v) => comparable(v) === left);
      case "gt":
      case "lt": {
        const right = comparable(filter.value);
        if (left === null || right === null || typeof left !== typeof right) return false;
        return filter.op === "gt" ? left > right : left < right;
      }
    }
  });
}

/** Unknown filter fields are an error naming the real ones, not an empty list. */
export function unknownFilterFields(
  def: Pick<RecordTypeDefinition, "fields">,
  filters: readonly RecordFieldFilter[],
): string[] {
  const known = new Set(def.fields.map((field) => field.key));
  return filters.map((filter) => filter.field).filter((key) => !known.has(key));
}

/* -------------------------------------------------------------------------- */
/*  The brief's view of them                                                  */
/* -------------------------------------------------------------------------- */

export interface CompactRecordType {
  key: string;
  label: string;
  /** Only when not `node`: a dataset-backed type is not a kind. */
  storage?: "dataset";
  /** `key:type`, `*` when required, `→target` for relations, options for selects (not the stage field). */
  fields: string;
  stages?: string[];
}

/**
 * What `brief` says about the record types: enough to write a valid record
 * without fetching the definitions, in as few tokens as that takes. Labels
 * and descriptions of fields are left out — the key and type are what a
 * write needs; `admin(op=record_types)` has the rest.
 */
export function compactRecordTypes(types: readonly RecordTypeDefinition[]): CompactRecordType[] {
  return types.map((type) => {
    const fields = type.fields.map((field) => {
      let out = `${field.key}:${field.type}`;
      if (field.type === "relation") out += `→${field.target}${field.multiple ? "[]" : ""}`;
      if ((field.type === "select" || field.type === "multi_select") && field.key !== type.stage_field) {
        out += `(${(field.options ?? []).join("|")})`;
      }
      if (field.required) out += "*";
      return out;
    }).join(",");
    const stageField = type.stage_field ? type.fields.find((field) => field.key === type.stage_field) : undefined;
    return {
      key: type.key,
      label: type.label,
      ...(type.storage === "dataset" ? { storage: "dataset" as const } : {}),
      fields,
      ...(stageField?.options?.length ? { stages: stageField.options } : {}),
    };
  });
}
