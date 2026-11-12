/**
 * One record type.
 *
 *   PATCH  /api/workspaces/:ws/record-types/:key   RecordTypePatch → RecordType
 *   DELETE /api/workspaces/:ws/record-types/:key   (refused while nodes of it exist)
 *
 * Admin verb. `key` and `storage` are identity and cannot be patched.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { deleteRecordType, updateRecordType } from "@/lib/business/record-types";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

type Params = { params: Promise<{ ws: string; key: string }> };

export const PATCH = withRoute(async (req: Request, { params }: Params) => {
  const { ws, key } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  try {
    return Response.json(await updateRecordType(ctx.storage, key, body.data));
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});

export const DELETE = withRoute(async (req: Request, { params }: Params) => {
  const { ws, key } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  try {
    await deleteRecordType(ctx.storage, key);
    return Response.json({ ok: true, key });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
