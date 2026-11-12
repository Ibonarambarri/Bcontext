/**
 * POST /api/invites/:token/accept — join, as the signed-in person.
 *
 * `acceptInvitation` takes both kinds of invitation — the role-keyed ones the
 * members screen writes and the verb-and-reach ones written over MCP — and
 * re-checks the promise against what the inviter holds now. A refusal is a
 * 400 with the reason in `message`, which is what the page shows.
 */
import { gate } from "@/lib/auth/require";
import { acceptInvitation } from "@/lib/auth/invitations";
import { withRoute } from "@/lib/route";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { findInviteByToken } from "@/lib/workspaces/members";
import type { InviteAccepted } from "@bcontext-dev/contract/workspaces";

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to accept an invitation." },
      { status: 401 },
    );
  }
  const { token } = await params;
  // Missing, expired and accepted are one 404, as on the preview route.
  if (!(await findInviteByToken(token))) {
    return Response.json(
      { error: "not_found", message: "Invitation is invalid or expired." },
      { status: 404 },
    );
  }
  const { data } = await getSupabaseForRequest(req).auth.getUser();
  const result = await acceptInvitation(token, {
    id: gated.userId,
    email: data.user?.email ?? null,
  });
  if ("error" in result) {
    return Response.json({ error: "invite_rejected", message: result.error }, { status: 400 });
  }
  // Every invitation is to one workspace, which is where the person lands.
  const accepted: InviteAccepted = { workspaceSlug: result.workspaceSlug };
  return Response.json(accepted);
});
