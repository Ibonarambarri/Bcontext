/**
 * POST /api/workspaces/:ws/records/:type — batch upsert of records by
 * external id, from the customer's own product. `{ records: [{ external_id,
 * title?, fields }] }`, at most 500.
 *
 * Ingest API: authenticated by an ingest key only (`openIngestWorkspace`),
 * which can write records and events and read nothing. Each record is
 * validated against the record type; a bad one is reported in its slot and
 * does not fail the batch. Docs: docs/ingest-api.md.
 */
import { RecordBatchSchema } from "@bcontext-dev/contract/business/ingest";
import { openIngestWorkspace } from "@/lib/auth/workspace";
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
