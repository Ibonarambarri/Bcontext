/**
 * POST /api/workspaces/:ws/invites/:id/email — email a pending invitation.
 *
 * Creating the invitation only makes a link; this is where one leaves the
 * building, and it is a separate call for the reason `@/lib/auth/invitations`
 * spells out: every other action here is reversible inside the database, a
 * sent email is not. Scoped to the workspace, so an id from another one
 * sends nothing.
 */
import { withRoute } from "@/lib/route";
import { membersErrorResponse, openForManagement } from "@/lib/workspaces/manage";
import { sendWorkspaceInvite } from "@/lib/workspaces/members";

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) => {
  const { ws, id } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(await sendWorkspaceInvite(ctx.storage.workspace.id, id));
  } catch (err) {
    return membersErrorResponse(err);
  }
});
