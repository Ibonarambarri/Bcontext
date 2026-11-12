/**
 * One record by the sender's id.
 *
 *   PUT    /api/workspaces/:ws/records/:type/:external_id   { title?, fields }
 *   DELETE /api/workspaces/:ws/records/:type/:external_id
 *
 * PUT upserts: created the first time, fields merged after (what is sent
 * overwrites, what is not keeps its value). DELETE is the erasure a person
 * can ask for (GDPR art. 17): it removes the node or the dataset row and
 * replaces the subject's id on its events with an opaque token, so the
 * metrics still add up and nothing leads back to them.
 *
 * Ingest API: ingest keys only (`openIngestWorkspace`). Docs: docs/ingest-api.md.
 */
import { ExternalIdSchema, RecordUpsertSchema } from "@bcontext-dev/contract/business/ingest";
import { openIngestWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse, ingestRecords } from "@/lib/business/http";
import { getRecordType } from "@/lib/business/record-types";
import { eraseRecord } from "@/lib/business/records";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

type Params = { params: Promise<{ ws: string; type: string; external_id: string }> };

export const PUT = withRoute(async (req: Request, { params }: Params) => {
  const { ws, type, external_id } = await params;
  const ctx = await openIngestWorkspace(req, ws);
  if (ctx instanceof Response) return ctx;
  const id = ExternalIdSchema.safeParse(external_id);
  if (!id.success) return Response.json({ error: "invalid_request", message: id.error.issues[0]?.message }, { status: 400 });
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = RecordUpsertSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await ingestRecords(ctx.storage, type, [{ external_id: id.data, ...parsed.data }]);
    if (result instanceof Response) return result;
    const one = result.results[0]!;
    if (one.status === "invalid") return Response.json({ error: "invalid_fields", ...one }, { status: 422 });
    return Response.json(one, { status: one.status === "created" ? 201 : 200 });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});

export const DELETE = withRoute(async (req: Request, { params }: Params) => {
  const { ws, type, external_id } = await params;
  const ctx = await openIngestWorkspace(req, ws);
  if (ctx instanceof Response) return ctx;
  try {
    const recordType = await getRecordType(ctx.storage, type);
    if (!recordType) {
      return Response.json({ error: "unknown_record_type", message: `no record type \`${type}\`` }, { status: 404 });
    }
    return Response.json(await eraseRecord(ctx.storage, recordType, external_id));
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
