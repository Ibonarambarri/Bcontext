/**
 * GET /api/workspaces/:ws/usage — what the workspace is consuming this month
 * (`WorkspaceUsage`): context held, writes by people and by agents, MCP reads
 * by tool, model calls, members and agents.
 *
 * Admin verb, held by a person: it is the administrator's screen. Measured,
 * never priced and never enforced — see `@/lib/workspaces/usage`.
 */
import { withRoute } from "@/lib/route";
import { openForManagement } from "@/lib/workspaces/manage";
import { getWorkspaceUsage } from "@/lib/workspaces/usage";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  return Response.json(await getWorkspaceUsage(ctx.storage.workspace.id));
});
