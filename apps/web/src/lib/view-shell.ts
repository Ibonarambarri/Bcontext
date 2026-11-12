/**
 * Where things are inside a workspace: the system view keys and the URL
 * builders the sidebar, header and inspector share. Everything returns a
 * typed `Route` on top of `workspacePath`, so a renamed section is a
 * one-file change.
 */
import type { Route } from "next";
import { workspacePath, type WorkspaceAddress } from "@/web/workspace-url";

/** The built-in views, in no particular order; `v/[view]/page.tsx` renders each by key. */
export const SYSTEM_VIEW_KEYS = [
  "overview",
  "graph",
  "tasks",
  "roadmap",
  "browse",
  "credentials",
  "changes",
  "agents",
  "tools",
] as const;

export type SystemViewKey = (typeof SYSTEM_VIEW_KEYS)[number];
/** Where the person was last in a workspace, kept in this browser's localStorage (`local-settings.ts`). */
export interface WorkspaceNavigationPreference {
  last_view_slug: string;
}

export const DEFAULT_WORKSPACE_NAVIGATION: WorkspaceNavigationPreference = {
  last_view_slug: "overview",
};

/** Overview is the workspace root itself; every other system view lives under `v/`. */
export function systemViewPath(ws: WorkspaceAddress, key: SystemViewKey): Route {
  if (key === "overview") return workspacePath(ws) as Route;
  return workspacePath(ws, `v/${key}`) as Route;
}

export function customViewPath(ws: WorkspaceAddress, viewSlug: string): Route {
  return workspacePath(ws, `v/${encodeURIComponent(viewSlug)}`) as Route;
}

/** `/n/<id>#<block>` — the address agents and backlinks use for a section. */
export function nodeDeepLink(
  ws: WorkspaceAddress,
  nodeId: string,
  blockId?: string | null,
): Route {
  const base = workspacePath(ws, `n/${encodeURIComponent(nodeId)}`);
  return (blockId ? `${base}#${encodeURIComponent(blockId)}` : base) as Route;
}

/**
 * The fullscreen node route with the state the inspector needs to come back:
 * which node is open, which block, and where the person was standing.
 */
export function fullNodeUrl(
  ws: WorkspaceAddress,
  args: { nodeId: string; blockId?: string | null; returnTo: string },
): Route {
  const params = new URLSearchParams({ inspect: args.nodeId, return_to: args.returnTo });
  if (args.blockId) params.set("block", args.blockId);
  const base = workspacePath(ws, `n/${encodeURIComponent(args.nodeId)}`);
  const hash = args.blockId ? `#${encodeURIComponent(args.blockId)}` : "";
  return `${base}?${params.toString()}${hash}` as Route;
}

/** The view slug a pathname is showing, for highlighting nav; null outside the view routes. */
export function viewSlugFromPathname(pathname: string, ws: WorkspaceAddress): string | null {
  const base = workspacePath(ws);
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (normalized === base) return "overview";
  if (normalized === `${base}/views`) return "overview";
  const prefix = `${base}/v/`;
  if (!normalized.startsWith(prefix)) return null;
  const segment = normalized.slice(prefix.length).split("/")[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export type LegacyAdminSurface = "agents" | "connections";

/**
 * Map the retired Connections/tabs URLs to where each surface lives now: the
 * `agents` view, or `tools` for the old tool-provider tabs. The rest of the
 * query rides along.
 */
export function legacyAdminDestination(
  ws: WorkspaceAddress,
  source: LegacyAdminSurface,
  query: URLSearchParams,
): Route {
  const next = new URLSearchParams(query);
  const tab = next.get("tab");
  next.delete("tab");
  const surface = tab === "providers" || tab === "tools" || tab === "webhooks" ? "tools" : "agents";
  if (source === "connections" && !tab) next.delete("surface");
  const suffix = next.toString();
  return `${systemViewPath(ws, surface)}${suffix ? `?${suffix}` : ""}` as Route;
}

/** The retired `/browse` and `/nodes` pages: same query, on the workspace root. */
export function legacyBrowseDestination(ws: WorkspaceAddress, query: URLSearchParams): Route {
  const suffix = query.toString();
  return `${workspacePath(ws)}${suffix ? `?${suffix}` : ""}` as Route;
}
