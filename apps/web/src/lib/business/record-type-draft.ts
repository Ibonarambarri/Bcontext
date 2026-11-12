/**
 * The record type editor's working copy, and its way back to the contract's
 * input and patch shapes.
 *
 * Who uses it: `app/workspaces/workspace-admin/record-types-section.tsx`.
 * Pure and tested (`record-type-draft.test.ts`): what the editor sends is
 * exactly what the contract's zod schemas accept, and the errors the person
 * sees before saving are the schemas' own, field by field.
 *
 * Options are edited as one comma-separated line because a select's options
 * are short words, and a list editor for five words is more UI than data.
 * Must not break: an existing field's key is never changed by the editor
 * (values are stored under it; renaming it would orphan them) — only its
 * label, description and constraints are.
 */
import {
  RECORD_FIELD_TYPES,
  RecordTypeInputSchema,
  RecordTypePatchSchema,
  definitionIssues,
  type FieldTotalMode,
  type RecordFieldDef,
  type RecordFieldType,
  type RecordStorage,
  type RecordType,
  type RecordTypeInput,
  type RecordTypePatch,
} from "@bcontext-dev/contract/business/record-types";

export interface FieldDraft {
  key: string;
  label: string;
  type: RecordFieldType;
  required: boolean;
  optionsText: string;
  target: string;
  multiple: boolean;
  description: string;
  /** number / money: the footer total, `""` to let `fieldTotalOf` infer it from the key. */
  total: "" | FieldTotalMode;
  /** Added in this edit: its key is still editable. */
  isNew: boolean;
}

export interface TypeDraft {
  key: string;
  label: string;
  labelPlural: string;
  description: string;
  storage: RecordStorage;
  datasetNodeId: string;
  stageField: string;
  fields: FieldDraft[];
  /** Not yet created: key and storage are still editable. */
  isNew: boolean;
}

export const FIELD_TYPE_LABELS: Record<RecordFieldType, string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  boolean: "Yes / no",
  select: "Select",
  multi_select: "Multi-select",
  url: "URL",
  email: "Email",
  person: "Person (member)",
  relation: "Relation",
};

export const FIELD_TYPES = RECORD_FIELD_TYPES;

export const FIELD_TOTAL_LABELS: Record<"" | FieldTotalMode, string> = {
  "": "Total: automatic",
  sum: "Total: sum",
  average: "Total: average",
  none: "Total: none",
};

export function emptyField(): FieldDraft {
  return { key: "", label: "", type: "text", required: false, optionsText: "", target: "", multiple: false, description: "", total: "", isNew: true };
}

export function emptyType(): TypeDraft {
  return { key: "", label: "", labelPlural: "", description: "", storage: "node", datasetNodeId: "", stageField: "", fields: [], isNew: true };
}

export function draftFromType(type: RecordType): TypeDraft {
  return {
    key: type.key,
    label: type.label,
    labelPlural: type.label_plural ?? "",
    description: type.description ?? "",
    storage: type.storage,
    datasetNodeId: type.dataset_node_id ?? "",
    stageField: type.stage_field ?? "",
    fields: type.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      optionsText: (field.options ?? []).join(", "),
      target: field.target ?? "",
      multiple: Boolean(field.multiple),
      description: field.description ?? "",
      total: field.total ?? "",
      isNew: false,
    })),
    isNew: false,
  };
}

export function fieldDefFromDraft(draft: FieldDraft): RecordFieldDef {
  const choice = draft.type === "select" || draft.type === "multi_select";
  const options = draft.optionsText.split(",").map((option) => option.trim()).filter(Boolean);
  return {
    key: draft.key.trim(),
    label: draft.label.trim() || draft.key.trim(),
    type: draft.type,
    ...(draft.required ? { required: true } : {}),
    ...(choice ? { options } : {}),
    ...(draft.type === "relation" ? { target: draft.target.trim(), ...(draft.multiple ? { multiple: true } : {}) } : {}),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    // Kept through an edit even though most people never touch it: dropping
    // it would turn an Instructors' "avg 4.7" back into a sum of ratings.
    ...(draft.total && (draft.type === "number" || draft.type === "money") ? { total: draft.total } : {}),
  };
}

/** A label from a key: `renewal_date` → `Renewal date`. */
export function labelFromKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function issues(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((issue) => (issue.path.length && !issue.message.includes("`") ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
}

/** The create body, or the contract's reasons it would be refused. */
export function inputFromDraft(draft: TypeDraft): DraftResult<RecordTypeInput> {
  const input: RecordTypeInput = {
    key: draft.key.trim(),
    label: draft.label.trim(),
    label_plural: draft.labelPlural.trim() || null,
    description: draft.description.trim() || null,
    storage: draft.storage,
    dataset_node_id: draft.storage === "dataset" ? draft.datasetNodeId.trim() || null : null,
    fields: draft.fields.map(fieldDefFromDraft),
    stage_field: draft.stageField || null,
  };
  const parsed = RecordTypeInputSchema.safeParse(input);
  return parsed.success ? { ok: true, value: input } : { ok: false, errors: issues(parsed.error) };
}

/** The patch body (everything but key and storage), checked as a whole definition. */
export function patchFromDraft(draft: TypeDraft): DraftResult<RecordTypePatch> {
  const patch: RecordTypePatch = {
    label: draft.label.trim(),
    label_plural: draft.labelPlural.trim() || null,
    description: draft.description.trim() || null,
    fields: draft.fields.map(fieldDefFromDraft),
    stage_field: draft.stageField || null,
  };
  const parsed = RecordTypePatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  const merged = definitionIssues({
    key: draft.key,
    label: patch.label ?? draft.label,
    storage: draft.storage,
    dataset_node_id: draft.storage === "dataset" ? draft.datasetNodeId : null,
    fields: patch.fields ?? [],
    stage_field: patch.stage_field ?? null,
  });
  return merged.length ? { ok: false, errors: merged } : { ok: true, value: patch };
}
