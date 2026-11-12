/**
 * The MCP endpoint of one workspace: `/mcp/<slug>`.
 *
 *   POST /mcp/:workspace   — JSON-RPC requests
 *   GET  /mcp/:workspace   — SSE stream for server-pushed messages
 *
 * The path fixes the workspace, so a project folder can carry its own
 * `.mcp.json` and the OAuth a client runs from here is bound to that
 * workspace (the 401 advertises this endpoint's own protected-resource
 * document). A user token is checked for membership like an explicit
 * `X-Bcontext-Workspace`; a workspace token must belong to this workspace.
 * A malformed slug is a 404 like a workspace that does not exist — the path
 * is public, the answer must not say more than that.
 */
import { handleMcpRequest } from "@/lib/mcp/http";
import { withRoute } from "@/lib/route";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

type Params = { params: Promise<{ workspace: string }> };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { workspace } = await params;
  const ref = parseWorkspaceRef(workspace);
  if (ref?.kind !== "slug") {
    return Response.json(
      { error: "workspace_not_found", message: `workspace "${workspace}" not found` },
      { status: 404 },
    );
  }
  return handleMcpRequest(req, { workspaceRef: ref.slug });
}

export const POST = withRoute(handle);

export const GET = withRoute(handle);
