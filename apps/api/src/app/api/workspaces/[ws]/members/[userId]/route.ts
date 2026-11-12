/**
 * GET    /api/workspaces/:ws/members/:userId — one person in full
 *        (`WorkspaceMemberDetail`: membership + the agents they connected).
 * PATCH  /api/workspaces/:ws/members/:userId — change their role.
 * DELETE /api/workspaces/:ws/members/:userId — remove them.
 *
 * The roster's row controls. All three need the admin verb on the workspace,
 * held by a person; a token that wants to hand out access has `grant_access`
 * over MCP, which speaks verbs and reach rather than roles. The last owner
 * can be neither demoted nor removed (409 `last_owner`).
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { membersErrorResponse, openForManagement } from "@/lib/workspaces/manage";
import {
  getWorkspaceMemberDetail,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from "@/lib/workspaces/members";

type Params = { params: Promise<{ ws: string; userId: string }> };

const Body = z.object({
  role: z.enum(["owner", "admin", "editor", "viewer"]),
});

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws, userId } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(
      await getWorkspaceMemberDetail(ctx.storage.workspace.id, userId, ctx.actor.userId),
    );
  } catch (err) {
    return membersErrorResponse(err);
  }
});

export const PATCH = withRoute(async (req: Request, { params }: Params) => {
  const { ws, userId } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: "role must be owner, admin, editor or viewer" },
      { status: 400 },
    );
  }
  try {
    await updateWorkspaceMember(ctx.storage.workspace.id, userId, parsed.data.role, ctx.actor.userId);
    return Response.json({ ok: true, role: parsed.data.role });
  } catch (err) {
    return membersErrorResponse(err);
  }
});

export const DELETE = withRoute(async (req: Request, { params }: Params) => {
  const { ws, userId } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  try {
    await removeWorkspaceMember(ctx.storage.workspace.id, userId, ctx.actor.userId);
    return Response.json({ ok: true });
  } catch (err) {
    return membersErrorResponse(err);
  }
});
