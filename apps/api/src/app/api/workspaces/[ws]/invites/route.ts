/**
 * POST /api/workspaces/:ws/invites — invite an address with a role.
 *
 * The members screen's invite form. The list of open invitations rides on
 * `GET /api/workspaces/:ws/members`, beside the roster; a second listing here
 * would be the same rows twice.
 *
 * Role-keyed on purpose: the members screen speaks roles. Invitations that
 * carry verbs and reach come from `@/lib/auth/invitations` over MCP; both are
 * accepted by the same route.
 *
 * Creating an invitation sends nothing. The reply carries the link, which
 * the screen shows for copying; emailing it is a second, deliberate call
 * (`POST /api/workspaces/:ws/invites/:id/email`) because a send is the one
 * step here that cannot be undone.
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { membersErrorResponse, openForManagement } from "@/lib/workspaces/manage";
import { createWorkspaceInvite } from "@/lib/workspaces/members";
import type { CreateWorkspaceInviteResult } from "@bcontext-dev/contract/workspaces";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("editor"),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  try {
    const { token: _token, ...invite } = await createWorkspaceInvite({
      workspaceId: ctx.storage.workspace.id,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedBy: ctx.actor.userId,
    });
    const result: CreateWorkspaceInviteResult = { invite };
    return Response.json(result, { status: 201 });
  } catch (err) {
    return membersErrorResponse(err);
  }
});
