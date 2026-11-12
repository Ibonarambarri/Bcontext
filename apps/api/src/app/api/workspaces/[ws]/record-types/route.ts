/**
 * The workspace's record types (the kinds it defined for itself).
 *
 *   GET  /api/workspaces/:ws/record-types   → { record_types: RecordType[] }   (read)
 *   POST /api/workspaces/:ws/record-types   RecordTypeInput → RecordType         (admin)
 *
 * Reading them is for every member (the web needs them to render records);
 * defining them changes what every agent and person can write, so it takes
 * the admin verb — the same one `admin_write` over MCP checks.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { actingUserId } from "@/lib/auth/require";
import { businessErrorResponse } from "@/lib/business/http";
import { createRecordType, listRecordTypes } from "@/lib/business/record-types";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

type Params = { params: Promise<{ ws: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  return Response.json({ record_types: await listRecordTypes(ctx.storage) });
});

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  try {
    return Response.json(await createRecordType(ctx.storage, body.data, actingUserId(ctx.actor)), { status: 201 });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
