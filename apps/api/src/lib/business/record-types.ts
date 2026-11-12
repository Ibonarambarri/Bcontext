/**
 * The record type store: what kinds a workspace has defined for itself
 * (`record_types`, 0103), and its business settings (`workspaces.business_model`,
 * `business_currency`).
 *
 * Callers: `workspaceKinds` (every kind check), the record write paths
 * (`./records.ts`), the admin REST routes and `admin`/`admin_write` over MCP,
 * `brief`. Every function takes a `Storage` that `openWorkspace` already
 * scoped, and only ever reads or writes `storage.workspace.id` — the storage
 * layer is service-role, so the `where workspace_id` here is the tenant
 * boundary, exactly as in `datasets/rows.ts`.
 *
 * Demo backend: an in-memory map per workspace, so the local demo and the
 * tests can define types without Supabase. What must not break: a key is
 * never reused for a different storage, and a type is never deleted while
 * nodes of its kind exist (the DB refuses both too; this says why first).
 */
import {
  BusinessSettingsPatchSchema,
  RecordTypeInputSchema,
  RecordTypePatchSchema,
  RECORD_LIMITS,
  definitionIssues,
  isBusinessModel,
  type BusinessSettings,
  type RecordType,
  type RecordTypeDefinition,
} from "@bcontext-dev/contract/business/record-types";
import { isCoreKind } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";

export class RecordTypeError extends Error {
  constructor(
    public readonly code: "invalid" | "not_found" | "conflict" | "in_use",
    message: string,
  ) {
    super(message);
    this.name = "RecordTypeError";
  }
}

export function recordTypeErrorStatus(err: RecordTypeError): number {
  switch (err.code) {
    case "not_found":
      return 404;
    case "conflict":
    case "in_use":
      return 409;
    default:
      return 400;
  }
}

type Scoped = Pick<Storage, "backend" | "workspace">;

/* -- demo backend ------------------------------------------------------------ */

const demoTypes = new Map<string, RecordType[]>();
const demoSettings = new Map<string, BusinessSettings>();

/** Test seam: forget every demo record type and setting. */
export function _resetDemoBusiness(): void {
  demoTypes.clear();
  demoSettings.clear();
}

/* -- rows ------------------------------------------------------------------- */

const COLUMNS = "id, workspace_id, key, label, description, storage, dataset_node_id, definition, position, created_at, updated_at";

function fromRow(row: Record<string, unknown>): RecordType {
  const definition = (row.definition && typeof row.definition === "object" ? row.definition : {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    key: String(row.key),
    label: String(row.label),
    label_plural: (definition.label_plural as string | null | undefined) ?? null,
    description: (row.description as string | null) ?? null,
    storage: row.storage === "dataset" ? "dataset" : "node",
    dataset_node_id: (row.dataset_node_id as string | null) ?? null,
    fields: Array.isArray(definition.fields) ? (definition.fields as RecordType["fields"]) : [],
    stage_field: (definition.stage_field as string | null | undefined) ?? null,
    promotes_from: Array.isArray(definition.promotes_from) ? (definition.promotes_from as string[]) : null,
    position: Number(row.position ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function definitionColumn(def: RecordTypeDefinition): Record<string, unknown> {
  return {
    fields: def.fields,
    stage_field: def.stage_field ?? null,
    label_plural: def.label_plural ?? null,
    promotes_from: def.promotes_from?.length ? def.promotes_from : null,
  };
}

async function admin() {
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  return getSupabaseAdmin();
}

/* -- reads ------------------------------------------------------------------- */

export async function listRecordTypes(storage: Scoped): Promise<RecordType[]> {
  if (storage.backend !== "supabase") return [...(demoTypes.get(storage.workspace.id) ?? [])];
  const { data, error } = await (await admin())
    .from("record_types")
    .select(COLUMNS)
    .eq("workspace_id", storage.workspace.id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    // Before 0103 is applied the table does not exist; a workspace then has
    // no record types, which is the truth for it.
    if (error.code === "42P01") return [];
    throw new Error(`listRecordTypes: ${error.message}`);
  }
  return ((data ?? []) as Record<string, unknown>[]).map(fromRow);
}

export async function getRecordType(storage: Scoped, key: string): Promise<RecordType | null> {
  return (await listRecordTypes(storage)).find((type) => type.key === key) ?? null;
}

/** A node record type by key, or null for a core kind / dataset type / nothing. */
export async function nodeRecordType(storage: Scoped, kind: string): Promise<RecordType | null> {
  if (isCoreKind(kind)) return null;
  const type = await getRecordType(storage, kind);
  return type && type.storage === "node" ? type : null;
}

/* -- writes ------------------------------------------------------------------ */

/**
 * Cross-checks the contract cannot make: relation targets exist here, and a
 * dataset-backed type points at a `data` node of this workspace.
 */
async function checkAgainstWorkspace(
  storage: Storage,
  def: RecordTypeDefinition,
  existing: readonly RecordType[],
  checkPromotesFrom = true,
): Promise<void> {
  const keys = new Set([...existing.map((type) => type.key), def.key]);
  for (const field of def.fields) {
    if (field.type !== "relation" || !field.target) continue;
    if (!isCoreKind(field.target) && !keys.has(field.target)) {
      throw new RecordTypeError(
        "invalid",
        `field \`${field.key}\` targets \`${field.target}\`, which is neither a core kind nor a record type here`,
      );
    }
  }
  // Checked only when written: a source deleted later just stops matching,
  // and must not make every later edit of this type fail.
  for (const sourceKey of checkPromotesFrom ? def.promotes_from ?? [] : []) {
    const source = existing.find((type) => type.key === sourceKey);
    if (!source || source.storage !== "dataset") {
      throw new RecordTypeError(
        "invalid",
        `promotes_from names \`${sourceKey}\`, which is not a dataset-backed record type here` +
          (existing.some((type) => type.storage === "dataset") ? ` (dataset types: ${existing.filter((type) => type.storage === "dataset").map((type) => type.key).join(", ")})` : ""),
      );
    }
  }
  if (def.storage === "dataset") {
    const node = def.dataset_node_id ? await storage.getNode(def.dataset_node_id) : null;
    if (!node || node.kind !== "data") {
      throw new RecordTypeError("invalid", "dataset_node_id must be a `data` node of this workspace");
    }
  }
}

export async function createRecordType(
  storage: Storage,
  input: unknown,
  createdBy: string | null,
): Promise<RecordType> {
  const parsed = RecordTypeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecordTypeError("invalid", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const def = parsed.data as RecordTypeDefinition;
  const existing = await listRecordTypes(storage);
  if (existing.some((type) => type.key === def.key)) {
    throw new RecordTypeError("conflict", `a record type \`${def.key}\` already exists; update it instead`);
  }
  if (existing.length >= RECORD_LIMITS.maxRecordTypes) {
    throw new RecordTypeError("invalid", `a workspace holds at most ${RECORD_LIMITS.maxRecordTypes} record types`);
  }
  await checkAgainstWorkspace(storage, def, existing);

  const now = new Date().toISOString();
  if (storage.backend !== "supabase") {
    const created: RecordType = {
      ...def,
      label_plural: def.label_plural ?? null,
      description: def.description ?? null,
      dataset_node_id: def.dataset_node_id ?? null,
      stage_field: def.stage_field ?? null,
      promotes_from: def.promotes_from?.length ? def.promotes_from : null,
      id: crypto.randomUUID(),
      workspace_id: storage.workspace.id,
      position: existing.length,
      created_at: now,
      updated_at: now,
    };
    demoTypes.set(storage.workspace.id, [...existing, created]);
    return created;
  }
  const { data, error } = await (await admin())
    .from("record_types")
    .insert({
      workspace_id: storage.workspace.id,
      key: def.key,
      label: def.label,
      description: def.description ?? null,
      storage: def.storage,
      dataset_node_id: def.dataset_node_id ?? null,
      definition: definitionColumn(def),
      position: existing.length,
      created_by: createdBy,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new RecordTypeError("conflict", `a record type \`${def.key}\` already exists`);
    throw new Error(`createRecordType: ${error.message}`);
  }
  return fromRow(data as Record<string, unknown>);
}

export async function updateRecordType(
  storage: Storage,
  key: string,
  input: unknown,
): Promise<RecordType> {
  const parsed = RecordTypePatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecordTypeError("invalid", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const existing = await listRecordTypes(storage);
  const current = existing.find((type) => type.key === key);
  if (!current) throw new RecordTypeError("not_found", `no record type \`${key}\``);
  const patch = parsed.data;
  const next: RecordType = {
    ...current,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.label_plural !== undefined ? { label_plural: patch.label_plural } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
    ...(patch.stage_field !== undefined ? { stage_field: patch.stage_field } : {}),
    ...(patch.promotes_from !== undefined ? { promotes_from: patch.promotes_from?.length ? patch.promotes_from : null } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
  };
  const issues = definitionIssues(next);
  if (issues.length > 0) throw new RecordTypeError("invalid", issues.join("; "));
  await checkAgainstWorkspace(storage, next, existing, patch.promotes_from !== undefined);
  // Removing a field does not rewrite the records that hold a value for it:
  // the value stays in data.fields, invisible to validation, and comes back
  // if the field does. Rewriting every record on a definition edit is a
  // migration nobody asked for.

  if (storage.backend !== "supabase") {
    const updated = { ...next, updated_at: new Date().toISOString() };
    demoTypes.set(storage.workspace.id, existing.map((type) => (type.key === key ? updated : type)));
    return updated;
  }
  const { data, error } = await (await admin())
    .from("record_types")
    .update({
      label: next.label,
      description: next.description ?? null,
      definition: definitionColumn(next),
      position: next.position,
    })
    .eq("workspace_id", storage.workspace.id)
    .eq("key", key)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`updateRecordType: ${error.message}`);
  return fromRow(data as Record<string, unknown>);
}

export async function deleteRecordType(storage: Storage, key: string): Promise<void> {
  const current = await getRecordType(storage, key);
  if (!current) throw new RecordTypeError("not_found", `no record type \`${key}\``);
  if (current.storage === "node") {
    const nodes = await storage.listNodes({ kinds: [key], limit: 1 });
    if (nodes.length > 0) {
      throw new RecordTypeError(
        "in_use",
        `record type \`${key}\` still has nodes; delete them (or change their kind) before deleting the type`,
      );
    }
  }
  if (storage.backend !== "supabase") {
    demoTypes.set(storage.workspace.id, (demoTypes.get(storage.workspace.id) ?? []).filter((type) => type.key !== key));
    return;
  }
  const { error } = await (await admin())
    .from("record_types")
    .delete()
    .eq("workspace_id", storage.workspace.id)
    .eq("key", key);
  if (error) {
    if (error.code === "23503") throw new RecordTypeError("in_use", `record type \`${key}\` still has nodes`);
    throw new Error(`deleteRecordType: ${error.message}`);
  }
}

/* -- business settings -------------------------------------------------------- */

export async function getBusinessSettings(storage: Scoped): Promise<BusinessSettings> {
  if (storage.backend !== "supabase") {
    return demoSettings.get(storage.workspace.id) ?? { business_model: "product", currency: "EUR" };
  }
  // The bound row is read `select *` and `rowToWorkspace` keeps 0103's two
  // columns (`settings.test.ts` pins that).
  const row = storage.workspace as unknown as Record<string, unknown>;
  return {
    business_model: isBusinessModel(row.business_model) ? row.business_model : "product",
    currency: typeof row.business_currency === "string" ? row.business_currency : "EUR",
  };
}

export async function setBusinessSettings(storage: Scoped, input: unknown): Promise<BusinessSettings> {
  const parsed = BusinessSettingsPatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecordTypeError("invalid", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const current = await getBusinessSettings(storage);
  const next: BusinessSettings = {
    business_model: parsed.data.business_model ?? current.business_model,
    currency: parsed.data.currency ?? current.currency,
  };
  if (storage.backend !== "supabase") {
    demoSettings.set(storage.workspace.id, next);
    return next;
  }
  const { error } = await (await admin())
    .from("workspaces")
    .update({ business_model: next.business_model, business_currency: next.currency })
    .eq("id", storage.workspace.id);
  if (error) throw new Error(`setBusinessSettings: ${error.message}`);
  // Keep the bound row honest for the rest of this request.
  Object.assign(storage.workspace as unknown as Record<string, unknown>, {
    business_model: next.business_model,
    business_currency: next.currency,
  });
  // Templates per business model are a later step; this is where applying
  // one will hook in (a no-op until then, on purpose — no half template).
  return next;
}
