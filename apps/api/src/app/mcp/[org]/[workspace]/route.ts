/**
 * The pre-0100 MCP endpoint of one workspace: `/mcp/<org>/<workspace>`.
 *
 * Organizations are gone and the address is `/mcp/<slug>` now, but this path
 * is written into `.mcp.json` files and client configs we cannot reach. It
 * is served, not redirected: MCP clients POST JSON-RPC here and many do not
 * follow a redirect on POST, and their OAuth grant is bound to this exact URL
 * (RFC 8707 `resource`). So it behaves exactly as `/mcp/<slug>` for the
 * workspace the pair resolves to (`workspace_legacy_refs`, see
 * `@/lib/workspaces/resolve`), and its 401 points at this path's own
 * protected-resource document.
 */
import { handleMcpRequest } from "@/lib/mcp/http";
import { withRoute } from "@/lib/route";
import { legacyRefName, parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

type Params = { params: Promise<{ org: string; workspace: string }> };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { org, workspace } = await params;
  const ref = parseWorkspaceRef(legacyRefName(org, workspace));
  if (ref?.kind !== "legacy") {
    return Response.json(
      { error: "workspace_not_found", message: `workspace "${org}/${workspace}" not found` },
      { status: 404 },
    );
  }
  return handleMcpRequest(req, { workspaceRef: ref.name });
}

export const POST = withRoute(handle);

export const GET = withRoute(handle);
