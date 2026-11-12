/**
 * How a workspace is named when it has to travel as one string.
 *
 * A workspace is the top-level thing in Bcontext, and its slug is unique
 * across the instance: `/w/<slug>` in the web, `/mcp/<slug>` for agents,
 * `?workspace=<slug>` and `/api/workspaces/<slug>` in the REST API.
 *
 * Two older spellings are still read, because they were written into
 * `.mcp.json` files, bookmarks and agent prompts while workspaces lived
 * inside organizations:
 *   `<org>/<workspace>`  — URLs, MCP arguments, the `X-Bcontext-Workspace` header
 *   `<org>~<workspace>`  — the same pair inside one REST path segment
 *
 * `parseWorkspaceRef` returns those as `legacy`, never as a slug: the
 * migration that removed organizations (0100) had to rename a workspace whose
 * slug collided with another organization's, so the second half of an old
 * pair is not always the workspace's slug today. The API resolves a legacy
 * pair through `workspace_legacy_refs`, which records every pair that existed.
 *
 * Shared by the API (resolution) and the web (legacy URL redirects). Must not
 * break: every spelling that was valid before keeps parsing to something.
 */

/** The shape every workspace slug has: lowercase, digits and dashes, ≤ 80. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** An old `<org>/<workspace>` pair, as it was written before 0100. */
export interface LegacyWorkspaceRef {
  org: string;
  workspace: string;
}

/** What a workspace reference turned out to be. */
export type WorkspaceRef =
  | { kind: "slug"; slug: string }
  | { kind: "legacy"; legacy: LegacyWorkspaceRef; name: string };

/** True when the value is shaped like a workspace slug. */
export function isWorkspaceSlug(raw: string | null | undefined): boolean {
  return WORKSPACE_SLUG_PATTERN.test((raw ?? "").trim().toLowerCase());
}

/**
 * `<org>/<workspace>` — the key `workspace_legacy_refs` stores a pair under.
 * Only for resolving old addresses; nothing new is ever named this way.
 */
export function legacyRefName(org: string, workspace: string): string {
  return `${org.toLowerCase()}/${workspace.toLowerCase()}`;
}

/**
 * Read a workspace reference: a slug, or one of the two legacy pair
 * spellings. Null for anything else (empty, three segments, bad characters).
 */
export function parseWorkspaceRef(raw: string | null | undefined): WorkspaceRef | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const sep = value.includes("~") ? "~" : value.includes("/") ? "/" : null;
  if (!sep) {
    return WORKSPACE_SLUG_PATTERN.test(value) ? { kind: "slug", slug: value } : null;
  }
  const parts = value.split(sep);
  if (parts.length !== 2) return null;
  const org = parts[0] ?? "";
  const workspace = parts[1] ?? "";
  if (!WORKSPACE_SLUG_PATTERN.test(org) || !WORKSPACE_SLUG_PATTERN.test(workspace)) return null;
  return { kind: "legacy", legacy: { org, workspace }, name: legacyRefName(org, workspace) };
}
