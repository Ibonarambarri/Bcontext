/**
 * "What's new" — the review surface's pure half: what counts as new since a
 * person's last visit, and how it is grouped (by who did it, then by node).
 *
 * Called by `components/whats-new-view.tsx` (the view) and
 * `components/whats-new-badge.ts` (the sidebar count). The data is the
 * existing Changes feed (`GET /api/activity`, the same rows `list_changes`
 * gives agents) and the ingest inbox; nothing here fetches.
 *
 * What must not break: the viewer's own changes are never "new" to them —
 * the point of the view is reviewing what agents and other people did — and
 * the count the sidebar shows must equal what the view lists.
 */
import type { ActivityEntry } from "@bcontext-dev/contract/activity";
import type { NodeKind } from "@bcontext-dev/contract/types";

/** Dispatched on `window` when the last-visit mark moves, so the badge recounts. */
export const LAST_VISIT_EVENT = "bcontext:last-visit-changed";

/** First visit (or a new browser): look this far back instead of at everything. */
export const DEFAULT_LOOKBACK_DAYS = 7;

/** How many changes one load reads; the badge says "99+" past what it can count. */
export const WHATS_NEW_PAGE = 100;

/** Where "since my last visit" starts: the stored mark, else the look-back window. */
export function sinceFor(stored: string | null, now: Date = new Date()): string {
  if (stored && Number.isFinite(Date.parse(stored))) return stored;
  return new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
}

/** A change the viewer made themselves, through the web as a person. */
export function isOwnChange(entry: ActivityEntry, selfId: string | null): boolean {
  if (!selfId) return false;
  const kind = entry.actor?.kind ?? entry.actor_kind;
  const id = entry.actor?.id ?? entry.actor_principal_id ?? entry.actor_id;
  return kind === "human" && id === selfId;
}

/** The changes "What's new" is about: everything since, minus the viewer's own. */
export function newChanges(entries: ActivityEntry[], selfId: string | null): ActivityEntry[] {
  return entries.filter((entry) => !isOwnChange(entry, selfId));
}

const DECISION_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["decision", "adr"]);

/**
 * Decisions (and ADRs) created since the last visit, one per node. They go on
 * top because a decision an agent recorded is the change most worth a
 * person's second look.
 */
export function newDecisions(entries: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "create" || !entry.node_id || !entry.node_kind) continue;
    if (!DECISION_KINDS.has(entry.node_kind) || seen.has(entry.node_id)) continue;
    seen.add(entry.node_id);
    out.push(entry);
  }
  return out;
}

/** Changes whose writer asked for a review that is still open. */
export function pendingReviews(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.filter((entry) => entry.review?.status === "pending");
}

export interface NodeGroup {
  key: string;
  node_id: string | null;
  title: string;
  node_kind: NodeKind | null;
  /** Distinct actions, in the order they first happened (oldest first). */
  actions: string[];
  latest: string;
  entries: ActivityEntry[];
}

export interface ActorGroup {
  key: string;
  name: string;
  kind: "human" | "agent" | "system" | null;
  count: number;
  latest: string;
  nodes: NodeGroup[];
}

function actorKey(entry: ActivityEntry): string {
  const kind = entry.actor?.kind ?? entry.actor_kind ?? "unknown";
  const id = entry.actor?.id ?? entry.actor_principal_id ?? entry.actor_id;
  return `${kind}:${id ?? entry.actor?.name ?? entry.actor_label}`;
}

/**
 * Group by who made the change, then by the node it touched. Actors and
 * nodes are ordered most recent first; a workspace event with no node is
 * its own group. Input order does not matter.
 */
export function groupByActor(entries: ActivityEntry[]): ActorGroup[] {
  const actors = new Map<string, ActorGroup & { byNode: Map<string, NodeGroup> }>();
  const ordered = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const entry of ordered) {
    const key = actorKey(entry);
    let actor = actors.get(key);
    if (!actor) {
      actor = {
        key,
        name: entry.actor?.name?.trim() || entry.actor_label,
        kind: entry.actor?.kind ?? entry.actor_kind ?? null,
        count: 0,
        latest: entry.ts,
        nodes: [],
        byNode: new Map(),
      };
      actors.set(key, actor);
    }
    actor.count += 1;
    if (entry.ts > actor.latest) actor.latest = entry.ts;
    const nodeKey = entry.node_id ?? `event:${entry.id}`;
    let node = actor.byNode.get(nodeKey);
    if (!node) {
      node = {
        key: nodeKey,
        node_id: entry.node_id,
        title: entry.node_title ?? entry.summary ?? "Workspace event",
        node_kind: entry.node_kind,
        actions: [],
        latest: entry.ts,
        entries: [],
      };
      actor.byNode.set(nodeKey, node);
    }
    // The newest title wins: a rename should show the name it has now.
    if (entry.node_title) node.title = entry.node_title;
    if (entry.node_kind) node.node_kind = entry.node_kind;
    if (!node.actions.includes(entry.action)) node.actions.push(entry.action);
    if (entry.ts > node.latest) node.latest = entry.ts;
    node.entries.push(entry);
  }
  return [...actors.values()]
    .map(({ byNode, ...actor }) => ({
      ...actor,
      nodes: [...byNode.values()].sort((a, b) => b.latest.localeCompare(a.latest)),
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

/** The newest timestamp among the entries, or null for none. */
export function newestTs(entries: ActivityEntry[]): string | null {
  let newest: string | null = null;
  for (const entry of entries) if (!newest || entry.ts > newest) newest = entry.ts;
  return newest;
}

/** What the sidebar badge shows: nothing at zero, "99+" past the page it can count. */
export function badgeLabel(count: number, capped = false): string | null {
  if (count <= 0) return null;
  if (capped || count > 99) return "99+";
  return String(count);
}
