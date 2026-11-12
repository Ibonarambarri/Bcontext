/**
 * Where the business layer lives on the API, as the web calls it: one file
 * of path builders and the readers of what those routes answer.
 *
 * Who uses it: the server reads in `@/web/business` and every client
 * component under `components/business` and the workspace panel's business
 * sections. Nothing else should spell one of these paths — a route that
 * moves is a change here and nowhere else.
 *
 * The shapes are the contract's (`@bcontext-dev/contract/business/*`):
 *   GET/PATCH /business            → BusinessSettings (bare)
 *   GET       /metrics/summary     → MetricsSummary
 *   GET/POST  /record-types        → { record_types } / RecordType
 *   PATCH/DELETE /record-types/:key
 *   GET/POST  /ingest-keys         → { keys } / CreateIngestKeyResult
 *   DELETE    /ingest-keys/:id
 *   GET       /records/:type       → RecordListResponse
 *   GET       /events?subject_…    → SubjectEventsResponse
 *   POST      /business/apply-template — the business templates work; until
 *             it is deployed the call fails and says so.
 *
 * Must not break: every path is under `/api/workspaces/<slug>/…`, which is
 * what the API's `openWorkspace` scopes by the caller's grant. The web never
 * reaches business data any other way.
 */
import type { RecordListResponse } from "@bcontext-dev/contract/business/ingest";
import type { BusinessSettings, RecordType } from "@bcontext-dev/contract/business/record-types";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

type Ws = string | WorkspaceAddress;

const base = (ws: Ws) => `/api/workspaces/${encodeURIComponent(workspaceApiRef(ws))}`;

export const businessPaths = {
  settings: (ws: Ws) => `${base(ws)}/business`,
  applyTemplate: (ws: Ws) => `${base(ws)}/business/apply-template`,
  metricsSummary: (ws: Ws) => `${base(ws)}/metrics/summary`,
  recordTypes: (ws: Ws) => `${base(ws)}/record-types`,
  recordType: (ws: Ws, key: string) => `${base(ws)}/record-types/${encodeURIComponent(key)}`,
  ingestKeys: (ws: Ws) => `${base(ws)}/ingest-keys`,
  ingestKey: (ws: Ws, id: string) => `${base(ws)}/ingest-keys/${encodeURIComponent(id)}`,
  events: (ws: Ws, query: { subjectType?: string; subjectId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.subjectType) params.set("subject_type", query.subjectType);
    if (query.subjectId) params.set("subject_id", query.subjectId);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    return `${base(ws)}/events${qs ? `?${qs}` : ""}`;
  },
  /** GET reads a node type's records with their fields; an app POSTs a batch here. */
  records: (ws: Ws, type: string, limit?: number) =>
    `${base(ws)}/records/${encodeURIComponent(type)}${limit ? `?limit=${limit}` : ""}`,
} as const;

/**
 * The settings, bare as the route answers them, or wrapped in `{ business }`
 * should a route ever wrap them — reading both costs nothing.
 */
export function readBusinessSettings(body: unknown): BusinessSettings | null {
  if (!body || typeof body !== "object") return null;
  const inner = (body as { business?: unknown }).business ?? body;
  const { business_model, currency } = inner as Partial<BusinessSettings>;
  if (typeof business_model !== "string") return null;
  return { business_model, currency: typeof currency === "string" ? currency : "EUR" };
}

/** Record types from `{ record_types }`. */
export function readRecordTypes(body: unknown): RecordType[] {
  if (Array.isArray(body)) return body as RecordType[];
  const list = (body as { record_types?: unknown } | null)?.record_types;
  return Array.isArray(list) ? (list as RecordType[]) : [];
}

/** Node records from a `RecordListResponse`. */
export function readRecords(body: unknown): KnowledgeNode[] {
  const list = (body as Partial<RecordListResponse> | null)?.records;
  return Array.isArray(list) ? list : [];
}
