/**
 * GET /.well-known/oauth-protected-resource/mcp/:org/:workspace
 *
 * The RFC 9728 document of the legacy `/mcp/<org>/<workspace>` alias (see
 * `app/mcp/[org]/[workspace]`). Its `resource` stays the legacy URL: a client
 * configured with that URL validates that the document describes it, and a
 * grant bound to it must keep matching the workspace it resolves to.
 *
 * Public discovery, like the slug form: only the shape is checked.
 */
import { withRoute } from "@/lib/route";
import { baseUrlFor, protectedResourceMetadata } from "@/lib/mcp/resource";
import { legacyRefName, parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; workspace: string }> },
) => {
  const { org, workspace } = await params;
  const ref = parseWorkspaceRef(legacyRefName(org, workspace));
  if (ref?.kind !== "legacy") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(
    protectedResourceMetadata(baseUrlFor(req), ref.name),
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
});
