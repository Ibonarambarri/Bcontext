/**
 * Records: nodes (or dataset rows) of a workspace's record types.
 *
 * Every path that writes one goes through here — `nodes_write` and the REST
 * node routes (an agent or a person creating an `account`), the ingest API
 * (a SaaS app pushing its customers), `data_write(op=promote_row)` — so a
 * record is validated by one rule whoever sends it: the contract's
 * `validateRecordFields`, with errors that name the field.
 *
 * What lives where: field values in `data.fields`; the sender's id in
 * `data.external_id` (unique per workspace+kind, 0103); a promoted row's
 * origin in `data.source_row`. Those three are reserved — a `data` patch that
 * drops them gets them back (`mergeRecordData`), because losing
 * `external_id` turns the next ingest into a duplicate.
 *
 * Must not break: the tenant boundary. Lookups by external id go to the
 * database directly (the storage interface has no such query) and always
 * carry `storage.workspace.id`.
 */
import {
  RECORD_RESERVED_DATA_KEYS,
  datasetColumnTypeFor,
  promoteFit,
  readRecordFields,
  unknownKindMessage,
  validateRecordFields,
  type RecordFields,
  type RecordType,
} from "@bcontext-dev/contract/business/record-types";
import type { RecordErasureResult, RecordUpsertResult } from "@bcontext-dev/contract/business/ingest";
import { isCoreKind, type KnowledgeNode } from "@bcontext-dev/contract/types";
import { canonicalNodeData, type Storage } from "@/lib/storage";
import {
  deleteDatasetRowByKey,
  readDatasetRowByKey,
  upsertDatasetRows,
} from "@/lib/datasets";
import { listRecordTypes } from "./record-types";

export class RecordWriteError extends Error {
  constructor(
    public readonly code: "unknown_kind" | "invalid_fields" | "not_a_record" | "not_found" | "dataset_type",
    message: string,
  ) {
    super(message);
    this.name = "RecordWriteError";
  }
}

export function recordWriteErrorStatus(err: RecordWriteError): number {
  return err.code === "not_found" ? 404 : 400;
}

/* -- kind + fields on ordinary node writes ------------------------------------ */

export interface RecordCreateFields {
  kind: string;
  fields?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
}

/**
 * For a node create: refuse an unknown kind (naming the ones that exist),
 * and for a record kind validate `fields` and fold them into `data.fields`.
 * Returns the `data` to store. Core kinds pass through untouched — except
 * that `fields` on one is an error, not something silently dropped.
 */
export async function prepareNodeCreate(
  storage: Storage,
  input: RecordCreateFields,
): Promise<{ data: Record<string, unknown> | undefined; recordType: RecordType | null }> {
  if (isCoreKind(input.kind)) {
    if (input.fields && Object.keys(input.fields).length > 0) {
      throw new RecordWriteError("not_a_record", `\`fields\` belong to record types; \`${input.kind}\` is a core kind`);
    }
    return { data: input.data ?? undefined, recordType: null };
  }
  const types = await listRecordTypes(storage);
  const type = types.find((candidate) => candidate.key === input.kind && candidate.storage === "node");
  if (!type) {
    const dataset = types.find((candidate) => candidate.key === input.kind);
    throw new RecordWriteError(
      dataset ? "dataset_type" : "unknown_kind",
      dataset
        ? `\`${input.kind}\` records live in a dataset, not as nodes; write them with data_write(op=upsert_rows) or the ingest API, and promote one with op=promote_row`
        : unknownKindMessage(input.kind, types),
    );
  }
  const base = canonicalNodeData(input.data ?? {});
  const fromData = readRecordFields(base);
  const candidate = { ...fromData, ...(input.fields ?? {}) };
  const checked = validateRecordFields(type, candidate, "create");
  if (!checked.ok) throw new RecordWriteError("invalid_fields", checked.message);
  await assertRelationTargets(storage, type, checked.fields);
  return { data: { ...base, fields: checked.fields }, recordType: type };
}

/**
 * For a node update: merge `fields` into the stored ones (a key that is not
 * sent keeps its value; `null` clears an optional field), validate the
 * result's changed keys, and re-apply the reserved `data` keys a caller's
 * `data` patch dropped. Returns the `data` to write, or undefined when the
 * patch touches neither.
 */
export async function prepareNodeUpdate(
  storage: Storage,
  node: Pick<KnowledgeNode, "kind" | "data">,
  patch: { fields?: Record<string, unknown> | null; data?: Record<string, unknown> | null },
): Promise<Record<string, unknown> | undefined> {
  if (patch.fields === undefined && patch.data === undefined) return undefined;
  if (isCoreKind(node.kind)) {
    if (patch.fields && Object.keys(patch.fields).length > 0) {
      throw new RecordWriteError("not_a_record", `\`fields\` belong to record types; this node is a \`${node.kind}\``);
    }
    return patch.data ?? undefined;
  }
  const types = await listRecordTypes(storage);
  const type = types.find((candidate) => candidate.key === node.kind && candidate.storage === "node");
  const next = mergeRecordData(node.data, patch.data ?? undefined);
  if (!type) {
    // The type was deleted under the node (only possible when nothing else
    // checked): keep the node writable, but do not invent validation.
    if (patch.fields) next.fields = { ...readRecordFields(node.data), ...patch.fields };
    return next;
  }
  if (patch.fields) {
    const checked = validateRecordFields(type, patch.fields, "patch");
    if (!checked.ok) throw new RecordWriteError("invalid_fields", checked.message);
    await assertRelationTargets(storage, type, checked.fields);
    next.fields = { ...readRecordFields(next), ...checked.fields };
  }
  return next;
}

/**
 * `data` after a patch, with the reserved keys put back when the patch left
 * them out. A patch that *sets* one (an admin fixing an external id) wins.
 */
export function mergeRecordData(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = canonicalNodeData(current ?? {});
  if (patch === undefined) return base;
  const next = canonicalNodeData(patch);
  for (const key of RECORD_RESERVED_DATA_KEYS) {
    if (!(key in next) && key in base) next[key] = base[key];
  }
  return next;
}

/** Relation values must point at nodes of the declared kind, in this workspace. */
async function assertRelationTargets(storage: Storage, type: RecordType, fields: RecordFields): Promise<void> {
  for (const field of type.fields) {
    if (field.type !== "relation") continue;
    const value = fields[field.key];
    if (value === null || value === undefined) continue;
    const ids = Array.isArray(value) ? value : [value as string];
    for (const id of ids) {
      const target = await storage.getNode(id);
      if (!target) {
        throw new RecordWriteError("invalid_fields", `field \`${field.key}\`: node ${id} does not exist (or is out of reach)`);
      }
      if (field.target && target.kind !== field.target) {
        throw new RecordWriteError(
          "invalid_fields",
          `field \`${field.key}\`: node ${id} is a ${target.kind}, expected a ${field.target}`,
        );
      }
    }
  }
}

/* -- lookups by external id ---------------------------------------------------- */

/** The node of `kind` whose `data.external_id` is `externalId`, or null. */
export async function findRecordNode(
  storage: Storage,
  kind: string,
  externalId: string,
): Promise<KnowledgeNode | null> {
  if (storage.backend === "supabase") {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await getSupabaseAdmin()
      .from("nodes")
      .select("id")
      .eq("workspace_id", storage.workspace.id)
      .eq("kind", kind)
      .eq("data->>external_id", externalId)
      .maybeSingle();
    if (error) throw new Error(`findRecordNode: ${error.message}`);
    return data ? storage.getNode(String((data as { id: string }).id)) : null;
  }
  const nodes = await storage.listNodes({ kinds: [kind], limit: 10_000 });
  return nodes.find((node) => (node.data as { external_id?: unknown })?.external_id === externalId) ?? null;
}

/* -- ingest: upsert by external id --------------------------------------------- */

export interface RecordUpsertInput {
  external_id: string;
  title?: string;
  fields: Record<string, unknown>;
}

function sameFields(a: RecordFields, b: RecordFields): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
}

/**
 * Create or update one node record by its external id. Fields merge: what is
 * sent overwrites, what is not keeps its value, so an app can push the one
 * field that changed. Required fields are demanded only on create.
 */
export async function upsertNodeRecord(
  storage: Storage,
  type: RecordType,
  input: RecordUpsertInput,
  retried = false,
): Promise<RecordUpsertResult & { node?: KnowledgeNode; before?: KnowledgeNode }> {
  const existing = await findRecordNode(storage, type.key, input.external_id);
  if (!existing) {
    const checked = validateRecordFields(type, input.fields, "create");
    if (!checked.ok) return { external_id: input.external_id, status: "invalid", error: checked.message };
    try {
      await assertRelationTargets(storage, type, checked.fields);
    } catch (err) {
      if (err instanceof RecordWriteError) return { external_id: input.external_id, status: "invalid", error: err.message };
      throw err;
    }
    try {
      const node = await storage.createNode({
        title: input.title ?? input.external_id,
        kind: type.key,
        parent_id: null,
        data: { external_id: input.external_id, fields: checked.fields },
      });
      return { external_id: input.external_id, status: "created", node_id: node.id, node };
    } catch (err) {
      // Two deliveries of the same new record raced; the unique index on
      // (workspace, kind, external_id) let one in. Update that one instead —
      // once: a second unique violation is some other constraint, and
      // retrying it would loop.
      if (retried || !/duplicate key|unique/i.test(err instanceof Error ? err.message : String(err))) throw err;
      return upsertNodeRecord(storage, type, input, true);
    }
  }
  const checked = validateRecordFields(type, input.fields, "patch");
  if (!checked.ok) return { external_id: input.external_id, status: "invalid", error: checked.message };
  try {
    await assertRelationTargets(storage, type, checked.fields);
  } catch (err) {
    if (err instanceof RecordWriteError) return { external_id: input.external_id, status: "invalid", error: err.message };
    throw err;
  }
  const current = readRecordFields(existing.data);
  const merged = { ...current, ...checked.fields };
  const titleChanged = input.title !== undefined && input.title !== existing.title;
  if (!titleChanged && sameFields(current, merged)) {
    return { external_id: input.external_id, status: "unchanged", node_id: existing.id, node: existing };
  }
  const updated = await storage.updateNode(existing.id, {
    ...(titleChanged ? { title: input.title } : {}),
    data: { ...canonicalNodeData(existing.data), fields: merged },
  });
  return { external_id: input.external_id, status: "updated", node_id: existing.id, node: updated ?? existing, before: existing };
}

/**
 * Upsert dataset records: rows keyed by external id, the fields as columns
 * (plus `external_id` itself, so the rows are queryable by it). Validated
 * per record; the valid ones are written in one keyed upsert.
 */
export async function upsertDatasetRecords(
  storage: Storage,
  type: RecordType,
  inputs: readonly RecordUpsertInput[],
): Promise<RecordUpsertResult[]> {
  const results: RecordUpsertResult[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const input of inputs) {
    // Dataset records are merged by the database, so a patch-shaped check is
    // the right one: a re-send of two columns must not fail on a third.
    const checked = validateRecordFields(type, input.fields, "patch");
    if (!checked.ok) {
      results.push({ external_id: input.external_id, status: "invalid", error: checked.message });
      continue;
    }
    rows.push({ external_id: input.external_id, ...checked.fields });
    results.push({ external_id: input.external_id, status: "updated" });
  }
  if (rows.length === 0) return results;
  const declaredColumns = [
    { name: "external_id", type: "text" as const, nullable: false },
    ...type.fields.map((field) => ({ name: field.key, type: datasetColumnTypeFor(field.type), nullable: !field.required })),
  ];
  const before = new Set<string>();
  for (const row of rows) {
    const { row: existing } = await readDatasetRowByKey(storage, type.dataset_node_id!, String(row.external_id));
    if (existing) before.add(String(row.external_id));
  }
  await upsertDatasetRows(
    storage,
    type.dataset_node_id!,
    { rows, keyColumn: "external_id" },
    { allowNewColumns: true, declaredColumns },
  );
  return results.map((result) =>
    result.status === "updated" && !before.has(result.external_id) ? { ...result, status: "created" } : result,
  );
}

/* -- promote a dataset row to a node record ------------------------------------ */

export interface PromoteRowInput {
  /** The dataset node. */
  node_id: string;
  key: string;
  record_type: string;
  title?: string;
  /** column → field; omitted, every column named like a field maps to it. */
  mapping?: Record<string, string>;
}

/**
 * A dataset row becomes a node of a record type: the moment a B2C person
 * (a row) becomes someone the team talks about (a node), e.g. a VIP client
 * or an instructor with an incident. The node keeps
 * `data.source_row = {dataset_node_id, key}`; promoting the same row again
 * updates that node instead of making a second one.
 */
export async function promoteDatasetRow(
  storage: Storage,
  input: PromoteRowInput,
): Promise<{ node: KnowledgeNode; created: boolean }> {
  const types = await listRecordTypes(storage);
  const type = types.find((candidate) => candidate.key === input.record_type);
  if (!type || type.storage !== "node") {
    throw new RecordWriteError(
      "unknown_kind",
      type ? `\`${input.record_type}\` is dataset-backed; promote into a node record type` : unknownKindMessage(input.record_type, types),
    );
  }
  const { node: dataset, row } = await readDatasetRowByKey(storage, input.node_id, input.key);
  if (!row) throw new RecordWriteError("not_found", `no row with key \`${input.key}\` in \`${dataset.title}\``);
  // The default mapping: when the dataset is a record type's, only the
  // columns whose values fit the target's field (`promoteFit`) — a column
  // that shares a name but not a meaning (a supplier's `status` vs an
  // incident's) would only fail validation. A bare dataset keeps the
  // name-for-name mapping it always had.
  const sourceType = types.find((candidate) => candidate.storage === "dataset" && candidate.dataset_node_id === dataset.id);
  let mapping = input.mapping;
  if (!mapping && sourceType) {
    const fit = promoteFit(sourceType, type);
    if (fit.missing_required.length > 0) {
      throw new RecordWriteError(
        "invalid_fields",
        `a \`${sourceType.key}\` row cannot become \`${type.key}\`: no compatible column fills its required field(s) ${fit.missing_required.join(", ")}; pass a mapping or promote into another type`,
      );
    }
    mapping = fit.mapping;
  }
  if (!mapping) {
    const fieldKeys = new Set(type.fields.map((field) => field.key));
    mapping = Object.fromEntries(Object.keys(row).filter((column) => fieldKeys.has(column)).map((column) => [column, column]));
  }
  const fields: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(mapping)) {
    if (!(column in row)) throw new RecordWriteError("invalid_fields", `mapping names column \`${column}\`, which the row does not have (columns: ${Object.keys(row).join(", ")})`);
    if (row[column] !== null && row[column] !== undefined) fields[field] = row[column];
  }
  const sourceRow = { dataset_node_id: dataset.id, key: input.key };
  const existing = (await storage.listNodes({ kinds: [type.key], limit: 10_000 })).find((candidate) => {
    const source = (candidate.data as { source_row?: { dataset_node_id?: string; key?: string } })?.source_row;
    return source?.dataset_node_id === sourceRow.dataset_node_id && source?.key === sourceRow.key;
  });
  if (existing) {
    const next = await prepareNodeUpdate(storage, existing, { fields });
    const updated = await storage.updateNode(existing.id, {
      ...(input.title ? { title: input.title } : {}),
      ...(next ? { data: next } : {}),
    });
    return { node: updated ?? existing, created: false };
  }
  const { data } = await prepareNodeCreate(storage, { kind: type.key, fields, data: { source_row: sourceRow } });
  const titleColumn = ["name", "title", "display_name"].find((column) => typeof row[column] === "string" && row[column]);
  const node = await storage.createNode({
    title: input.title ?? (titleColumn ? String(row[titleColumn]) : input.key),
    kind: type.key,
    parent_id: null,
    data,
  });
  return { node, created: true };
}

/* -- erasure -------------------------------------------------------------------- */

/**
 * Forget one subject (GDPR art. 17): remove its record — the node, or the
 * dataset row — and replace its id on every event with one opaque token, so
 * the metrics (distinct buyers, churned customers) still add up and nothing
 * leads back to the person. The token is random, not a hash of the id: a
 * hash of a known id can be recomputed, which is not forgetting.
 */
export async function eraseRecord(
  storage: Storage,
  type: RecordType,
  externalId: string,
): Promise<RecordErasureResult> {
  let removed = false;
  if (type.storage === "node") {
    const node = await findRecordNode(storage, type.key, externalId);
    if (node) removed = await storage.deleteNode(node.id);
  } else if (type.dataset_node_id) {
    removed = await deleteDatasetRowByKey(storage, type.dataset_node_id, externalId);
  }
  const { unlinkSubject } = await import("./events");
  const unlinked = await unlinkSubject(storage, type.key, externalId);
  return { external_id: externalId, record_removed: removed, events_unlinked: unlinked };
}
