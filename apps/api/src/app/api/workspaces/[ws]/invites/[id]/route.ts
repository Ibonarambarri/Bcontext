/**
 * DELETE /api/workspaces/:ws/invites/:id — revoke a pending invitation.
 *
 * Scoped to the workspace: an id from another workspace deletes nothing, and
 * says nothing.
 */
import { withRoute } from "@/lib/route";
import { openForManagement } from "@/lib/workspaces/manage";
import { revokeWorkspaceInvite } from "@/lib/workspaces/members";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) => {
  const { ws, id } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  await revokeWorkspaceInvite(ctx.storage.workspace.id, id);
  return Response.json({ ok: true });
});
