/**
 * The browser's writes to the business layer: settings, the template, record
 * types, ingest keys and a record's fields. Relative `fetch("/api/…")`, which
 * Next proxies to the API like every other client call.
 *
 * Who uses it: the new workspace dialog, the workspace panel's business
 * sections and the record header's inline edit. Each function throws an
 * `Error` whose message is the API's own words (`{ message }` or
 * `{ error }`), because the API's refusals are written for the person.
 */
import type { CreateIngestKeyResult, IngestKey } from "@bcontext-dev/contract/business/ingest";
import type {
  BusinessModel,
  BusinessSettings,
  BusinessSettingsPatch,
  RecordFields,
  RecordType,
  RecordTypeInput,
  RecordTypePatch,
} from "@bcontext-dev/contract/business/record-types";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { businessPaths, readBusinessSettings, readRecordTypes } from "./endpoints";

type Ws = string | WorkspaceAddress;

export async function apiErrorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
  if (typeof body?.message === "string" && body.message) return body.message;
  if (typeof body?.error === "string" && body.error) return body.error;
  return `${fallback} (HTTP ${res.status})`;
}

async function call<T>(path: string, init: RequestInit & { json?: unknown }, fallback: string): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    cache: "no-store",
    ...rest,
    headers: json === undefined ? rest.headers : { "content-type": "application/json", ...(rest.headers ?? {}) },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  if (!res.ok) throw new Error(await apiErrorText(res, fallback));
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}

export async function fetchBusinessSettings(ws: Ws): Promise<BusinessSettings | null> {
  return readBusinessSettings(await call<unknown>(businessPaths.settings(ws), {}, "Couldn't read the business settings"));
}

export async function patchBusinessSettings(ws: Ws, patch: BusinessSettingsPatch): Promise<BusinessSettings | null> {
  return readBusinessSettings(await call<unknown>(businessPaths.settings(ws), { method: "PATCH", json: patch }, "Couldn't save the business settings"));
}

/** Additive: types, fields and views the workspace already has are kept. */
export async function applyBusinessTemplate(ws: Ws, model: BusinessModel): Promise<unknown> {
  return call<unknown>(businessPaths.applyTemplate(ws), { method: "POST", json: { business_model: model } }, "Couldn't apply the template");
}

export async function fetchRecordTypes(ws: Ws): Promise<RecordType[]> {
  return readRecordTypes(await call<unknown>(businessPaths.recordTypes(ws), {}, "Couldn't read the record types"));
}

export async function createRecordType(ws: Ws, input: RecordTypeInput): Promise<void> {
  await call<unknown>(businessPaths.recordTypes(ws), { method: "POST", json: input }, "Couldn't create the record type");
}

export async function updateRecordType(ws: Ws, key: string, patch: RecordTypePatch): Promise<void> {
  await call<unknown>(businessPaths.recordType(ws, key), { method: "PATCH", json: patch }, "Couldn't save the record type");
}

export async function deleteRecordType(ws: Ws, key: string): Promise<void> {
  await call<unknown>(businessPaths.recordType(ws, key), { method: "DELETE" }, "Couldn't delete the record type");
}

export async function fetchIngestKeys(ws: Ws): Promise<IngestKey[]> {
  const body = await call<{ keys?: IngestKey[] }>(businessPaths.ingestKeys(ws), {}, "Couldn't read the ingest keys");
  return body?.keys ?? [];
}

export async function createIngestKey(ws: Ws, name: string): Promise<CreateIngestKeyResult> {
  return call<CreateIngestKeyResult>(businessPaths.ingestKeys(ws), { method: "POST", json: { name } }, "Couldn't create the key");
}

export async function revokeIngestKey(ws: Ws, id: string): Promise<void> {
  await call<unknown>(businessPaths.ingestKey(ws, id), { method: "DELETE" }, "Couldn't revoke the key");
}

/**
 * One field of a node record, through the guarded node PATCH the panel and
 * page already use, sending `fields`: the API merges them into
 * `data.fields`, validates them against the record type and keeps the
 * reserved `data` keys. `if_updated_at` makes a concurrent write a 409
 * rather than a silent overwrite.
 */
export async function patchRecordField(
  ws: Ws,
  node: Pick<KnowledgeNode, "id" | "data" | "updated_at">,
  fields: RecordFields,
): Promise<KnowledgeNode> {
  const body = await call<{ node: KnowledgeNode }>(
    `/api/nodes/${encodeURIComponent(node.id)}`,
    { method: "PATCH", json: { workspace: workspaceApiRef(ws), fields, if_updated_at: node.updated_at } },
    "Couldn't save the field",
  );
  return body.node;
}
