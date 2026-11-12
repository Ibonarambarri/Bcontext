/**
 * The ingest API's shapes: write-only keys, and the record upserts a SaaS
 * app sends to keep its customers in Bcontext.
 *
 * Who uses it: the API routes under `/api/workspaces/:ws/records/*`,
 * `/events` and `/ingest-keys`; the web's settings screen for keys (PR4).
 *
 * Must not break: the key prefix. Every other route's bearer parser accepts
 * only `bctx_live_…`, which is what makes an ingest key unable to read
 * anything; changing the prefix to something that parser accepts would turn
 * a write-only key into a read key.
 */
import { z } from "zod";
import type { KnowledgeNode } from "../types.js";

/** Distinct from `bctx_live_` on purpose (see the header). */
export const INGEST_KEY_PREFIX = "bctx_ingest_";

export interface IngestKey {
  id: string;
  workspace_id: string;
  name: string;
  /** First chars of the plaintext, for recognising it in a list. */
  prefix: string;
  last4: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const CreateIngestKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

export interface CreateIngestKeyResult {
  /** The plaintext. Shown once, never again. */
  key: string;
  record: IngestKey;
}

/** An external id as the sender writes it: their primary key, as text. */
export const ExternalIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[^\s/]+$/, "external_id must not contain spaces or slashes");

export const RECORD_BATCH_MAX = 500;

/**
 * One record. `fields` are validated against the record type; `title` names
 * a node record (defaults to the external id) and is ignored for dataset
 * records, whose columns are the fields.
 */
export const RecordUpsertSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  fields: z.record(z.unknown()).default({}),
}).strict();

export const RecordBatchSchema = z.object({
  records: z.array(RecordUpsertSchema.extend({ external_id: ExternalIdSchema }).strict())
    .min(1)
    .max(RECORD_BATCH_MAX),
}).strict();

export type RecordUpsertStatus = "created" | "updated" | "unchanged" | "invalid";

export interface RecordUpsertResult {
  external_id: string;
  status: RecordUpsertStatus;
  /** Node records: the node id. Dataset records: absent. */
  node_id?: string;
  error?: string;
}

export interface RecordBatchResponse {
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  results: RecordUpsertResult[];
}

/** How many records `GET /records/:type` returns at most. */
export const RECORD_LIST_MAX = 1_000;

/**
 * `GET /api/workspaces/:ws/records/:type?limit=` — a node record type's
 * records with their `data` (and so `data.fields`), which the node index
 * leaves out. For the web's overview lists and 360 pages; a read for
 * members, never for an ingest key. Dataset types answer 400: their records
 * are rows, read through the dataset.
 */
export interface RecordListResponse {
  records: KnowledgeNode[];
  /** True when the type has more records than were returned. */
  truncated: boolean;
}

/** `DELETE /records/:type/:external_id` — what erasing a subject removed. */
export interface RecordErasureResult {
  external_id: string;
  record_removed: boolean;
  /** Events whose subject link was replaced by an opaque token. */
  events_unlinked: number;
}
