/**
 * DELETE /api/workspaces/:ws/ingest-keys/:id — revoke an ingest key. Its
 * next request is a 401; events it already stored stay (with the key
 * reference cleared only if the key row is ever deleted).
 *
 * A person with the admin verb (`openForManagement`).
 */
import { revokeIngestKey } from "@/lib/business/ingest-keys";
import { withRoute } from "@/lib/route";
import { openForManagement } from "@/lib/workspaces/manage";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) => {
  const { ws, id } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  const revoked = await revokeIngestKey(ctx.storage.workspace.id, id);
  return revoked ? Response.json({ ok: true, id }) : Response.json({ error: "not_found" }, { status: 404 });
});
