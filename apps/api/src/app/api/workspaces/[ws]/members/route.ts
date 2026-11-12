/**
 * GET /api/workspaces/:ws/members — the members screen: roster, open
 * invitations and the caller's own role (`WorkspaceMembersResponse`).
 *
 * Read verb, session-cookie callers only: a bearer token has no business
 * enumerating the people in a workspace. Invitations — addresses and live
 * links — are shown only to someone who administers the workspace.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { hasVerb } from "@/lib/auth/grants";
import { withRoute } from "@/lib/route";
import { getWorkspaceRole, listWorkspaceRoster } from "@/lib/workspaces/members";
import type { WorkspaceMembersResponse } from "@bcontext-dev/contract/workspaces";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const { storage, actor, grant } = ctx;
  if (actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (storage.backend !== "supabase") {
    const demo: WorkspaceMembersResponse = {
      members: [],
      invites: [],
      role: null,
      can_manage: false,
      demo: true,
    };
    return Response.json(demo);
  }

  const canManage = hasVerb(grant, "admin");
  const [role, roster] = await Promise.all([
    getWorkspaceRole(storage.workspace.id, actor.userId),
    listWorkspaceRoster(storage.workspace.id, actor.userId, { withInvites: canManage }),
  ]);
  const body: WorkspaceMembersResponse = {
    members: roster.members,
    invites: roster.invites,
    role,
    can_manage: canManage,
  };
  return Response.json(body);
});
