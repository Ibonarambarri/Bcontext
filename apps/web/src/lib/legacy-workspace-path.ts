/**
 * Telling a pre-0100 workspace URL (`/w/<org>/<workspace>/…`) apart from
 * today's (`/w/<slug>/…`), so `src/proxy.ts` can redirect the old ones.
 *
 * Until workspaces stood alone, every page lived two segments deep; those
 * URLs are in bookmarks, browser history, chat messages and node bodies, and
 * they must keep landing somewhere. Next cannot route both shapes (two sibling
 * dynamic segments under `/w` are not allowed), so the proxy — which already
 * runs before any page renders — asks this module which shape a path has and
 * answers the old one with a permanent redirect.
 *
 * The rule: in `/w/<a>/<b>/…`, if `<b>` is one of the static children of the
 * `app/w/[ws]` route tree, `<a>` is a workspace slug and the path is current;
 * otherwise `<a>/<b>` is a legacy pair. The pair is not resolved here — the
 * migration that removed organizations renamed a workspace whose slug
 * collided with another's, so `<b>` is not always today's slug. The proxy
 * asks the API (`GET /api/workspaces/<a>~<b>`) and uses `fallbackSlug` (the
 * old second half) only when the API will not say.
 *
 * Pure, no I/O, no Next imports: `legacy-workspace-path.test.ts` pins the
 * classification and checks `WORKSPACE_CHILD_SEGMENTS` against the route tree
 * on disk. Must not break: adding a static child under `app/w/[ws]` means
 * adding it to that list, or URLs under it would be taken for legacy pairs
 * and redirected away — the test fails until both agree.
 *
 * Known blind spot, accepted: an old workspace whose slug was itself one of
 * those segment names (a workspace called `n` or `views`) reads as a current
 * URL and 404s instead of redirecting.
 */
import { WORKSPACE_SLUG_PATTERN } from "@bcontext-dev/contract/workspace-ref";

/** The static first-level children of `app/w/[ws]`, i.e. what `<b>` can be in a current URL. */
export const WORKSPACE_CHILD_SEGMENTS: readonly string[] = [
  "agents",
  "browse",
  "connections",
  "n",
  "nodes",
  "s",
  "v",
  "views",
];

/** A legacy workspace URL, taken apart for the redirect. */
export interface LegacyWorkspacePath {
  /** The old pair as one REST path segment, `<a>~<b>`: what the API resolves. */
  ref: string;
  /** Where to send the person when the API cannot resolve the pair: the old second half. */
  fallbackSlug: string;
  /** Everything after the pair, with its leading slash (`/n/abc`), or "" for the workspace root. */
  rest: string;
}

/**
 * The legacy reading of a pathname, or null when it is a current workspace
 * URL (or not a workspace URL at all, which the proxy leaves to Next).
 */
export function legacyWorkspacePath(pathname: string): LegacyWorkspacePath | null {
  if (!pathname.startsWith("/w/")) return null;
  const segments = pathname.slice("/w/".length).split("/");
  const [first, second] = segments;
  if (!first || !second) return null;
  if (WORKSPACE_CHILD_SEGMENTS.includes(second)) return null;
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  // Anything not shaped like a slug was never a workspace address; leaving
  // it alone lets Next answer it with its ordinary 404.
  if (!WORKSPACE_SLUG_PATTERN.test(a) || !WORKSPACE_SLUG_PATTERN.test(b)) return null;
  const tail = segments.slice(2).join("/");
  return { ref: `${a}~${b}`, fallbackSlug: b, rest: tail ? `/${tail}` : "" };
}

/** The current URL path for a workspace slug and the rest of a legacy path. */
export function currentWorkspacePath(slug: string, rest: string): string {
  return `/w/${slug}${rest}`;
}
