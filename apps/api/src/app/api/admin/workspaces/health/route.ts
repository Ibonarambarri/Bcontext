/**
 * GET /api/admin/workspaces/health — one row per workspace answering, without
 * a second click, whether anyone accepted, whether anyone has ever signed in,
 * whether an agent has ever connected, and whether the place is still moving
 * this month. Instance admins only.
 *
 * It survives beside `GET /api/admin/workspaces`, which carries the same
 * figures, because the two answer different questions. The list answers
 * "show me this page, worst first" and is cut to a page; this answers "is
 * anything wrong anywhere" and is deliberately NOT paginated — the
 * Overview's alarm band counts every workspace in trouble, and a band that
 * counted the first fifty would go quiet exactly as the instance grew. Both
 * read the same sweep and the same ladder (`adminWorkspaceState`), so they
 * cannot disagree.
 */
import { gateAdmin } from "@/lib/admin/access";
import { listAdminWorkspaceHealth } from "@/lib/admin/workspaces";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  return Response.json(await listAdminWorkspaceHealth());
});
