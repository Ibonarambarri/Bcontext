/**
 * GET /.well-known/oauth-protected-resource/mcp/:workspace
 *
 * The RFC 9728 document of one workspace's MCP endpoint: the same as the
 * root document with `resource` set to `/mcp/<slug>`, at the path RFC 9728
 * §3.1 derives from the resource's own path. An MCP client that was pointed
 * at a workspace endpoint discovers it from the 401 there and sends that
 * `resource` to the authorize and token endpoints, which is what binds the
 * OAuth grant to the workspace.
 *
 * Public discovery: whether the workspace exists is not checked here (that
 * would be a cheap way to enumerate them), only that the slug is well-formed.
 */
import { withRoute } from "@/lib/route";
import { baseUrlFor, protectedResourceMetadata } from "@/lib/mcp/resource";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ workspace: string }> },
) => {
  const { workspace } = await params;
  const ref = parseWorkspaceRef(workspace);
  if (ref?.kind !== "slug") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(
    protectedResourceMetadata(baseUrlFor(req), ref.slug),
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
});
