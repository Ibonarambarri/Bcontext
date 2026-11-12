/**
 * POST /api/workspaces/:ws/records/:type — batch upsert of records by
 * external id, from the customer's own product. `{ records: [{ external_id,
 * title?, fields }] }`, at most 500.
 *
 * Ingest API: authenticated by an ingest key only (`openIngestWorkspace`),
 * which can write records and events and read nothing. Each record is
 * validated against the record type; a bad one is reported in its slot and
 * does not fail the batch. Docs: docs/ingest-api.md.
 *
 * GET /api/workspaces/:ws/records/:type?limit= — the type's node records
 * with their `data`, which the node index leaves out (`RecordListResponse`).
 * The web's business overview and 360 pages read fields from it. The read
 * verb through `openWorkspace`: members and `bctx_live_` tokens, never an
 * ingest key; the scoped storage decides which nodes the caller sees.
 */
import { RECORD_LIST_MAX, RecordBatchSchema, type RecordListResponse } from "@bcontext-dev/contract/business/ingest";
import { openIngestWorkspace, openWorkspace } from "@/lib/auth/workspace";
import { getRecordType } from "@/lib/business/record-types";
import { businessErrorResponse, ingestRecords } from "@/lib/business/http";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

/** 500 records with a handful of fields each, with room to spare. */
const MAX_BODY_BYTES = 1_000_000;

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; type: string }> },
) => {
  const { ws, type } = await params;
  const ctx = await openIngestWorkspace(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;
  const parsed = RecordBatchSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await ingestRecords(ctx.storage, type, parsed.data.records);
    return result instanceof Response ? result : Response.json(result);
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; type: string }> },
) => {
  const { ws, type } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const recordType = await getRecordType(ctx.storage, type);
  if (!recordType) {
    return Response.json({ error: "unknown_record_type", message: `this workspace has no record type \`${type}\`` }, { status: 404 });
  }
  if (recordType.storage !== "node") {
    return Response.json(
      { error: "dataset_record_type", message: `\`${type}\` records are rows of a dataset; read them through the dataset node` },
      { status: 400 },
    );
  }
  const rawLimit = Number(new URL(req.url).searchParams.get("limit") ?? RECORD_LIST_MAX);
  const limit = Math.max(1, Math.min(RECORD_LIST_MAX, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : RECORD_LIST_MAX));
  // One more than asked, to say whether the list was cut short.
  const nodes = await ctx.storage.listNodes({ kinds: [recordType.key], limit: limit + 1 });
  const body: RecordListResponse = { records: nodes.slice(0, limit), truncated: nodes.length > limit };
  return Response.json(body);
});
