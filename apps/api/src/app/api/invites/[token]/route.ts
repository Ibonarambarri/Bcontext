/**
 * GET /api/invites/:token — what an invitation link leads to.
 *
 * The invite page renders this before the person has signed in, so no session
 * is demanded: the token is the credential, unguessable and looked up only by
 * exact value. What comes back is what the page shows — the address it was
 * sent to, the role, the workspace — and not the token itself, which the
 * caller evidently has. Missing, expired and accepted are all the same 404:
 * anything finer would let a link be probed for its state.
 */
import { gate } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { findInviteByToken } from "@/lib/workspaces/members";
import type { InvitePreview } from "@bcontext-dev/contract/workspaces";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) => {
  // Anonymous is fine; the gate still rate-limits by IP.
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) return gated;
  const { token } = await params;
  const found = await findInviteByToken(token);
  if (!found) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const invite: InvitePreview = {
    email: found.email,
    role: found.role,
    workspace_name: found.workspace_name,
    workspace_slug: found.workspace_slug,
    expires_at: found.expires_at,
  };
  return Response.json({ invite });
});
