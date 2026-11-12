/**
 * Where a workspace lives, in URLs and in API calls.
 *
 * A workspace is the top-level thing in Bcontext and its slug is unique
 * across the instance, so the slug alone is its address: `/w/<slug>` for the
 * pages people open, and the same slug as the REST path segment
 * (`/api/workspaces/<slug>`) or `?workspace=<slug>` query parameter the API
 * takes.
 *
 * Every page, component and hook that links to or calls into a workspace
 * builds the address here, so a change of shape is one file. Must not break:
 * the path stays `/w/<slug>/<sub>` — `src/proxy.ts` tells it apart from the
 * legacy two-segment `/w/<a>/<b>` addresses by its second segment
 * (`@/lib/legacy-workspace-path`).
 */

/** A workspace as a route or a component holds it: by slug. */
export interface WorkspaceAddress {
  slug: string;
}

function slugOf(ws: string | WorkspaceAddress): string {
  return typeof ws === "string" ? ws : ws.slug;
}

/** The page URL: /w/<slug>, plus anything below it. */
export function workspacePath(ws: string | WorkspaceAddress, sub = ""): string {
  const tail = sub ? `/${sub.replace(/^\/+/, "")}` : "";
  return `/w/${slugOf(ws)}${tail}`;
}

/** The API reference — a path segment or a `?workspace=` value: the slug. */
export function workspaceApiRef(ws: string | WorkspaceAddress): string {
  return slugOf(ws);
}

/** How a workspace is named to an agent (MCP header, tool arguments): its slug. */
export function workspaceName(ws: string | WorkspaceAddress): string {
  return slugOf(ws);
}
