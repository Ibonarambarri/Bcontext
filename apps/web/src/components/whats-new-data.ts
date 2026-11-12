"use client";

/**
 * The data behind "What's new": the viewer's last-visit mark and the feed
 * since then. Used by the sidebar badge (`useWhatsNewCount`) and the view
 * itself (`whats-new-view.tsx`), so both count the same thing.
 *
 * Reads only existing endpoints, over HTTP: `GET /api/activity?since=…`
 * (the Changes feed, slim rows) and `GET /api/ingest/stats` (the pending
 * review count). The mark lives in this browser (`lastVisit` in
 * `local-settings.ts`, which says why). Every feed-changing broadcast and
 * every move of the mark recounts, debounced so a burst of agent writes is
 * one request, not twenty.
 *
 * What must not break: a failed read is a zero, never a toast — the badge
 * sits on every page of the workspace.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEntry } from "@bcontext-dev/contract/activity";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { lastVisit } from "@/lib/local-settings";
import { LAST_VISIT_EVENT, WHATS_NEW_PAGE, newChanges, sinceFor } from "@/lib/whats-new";
import { workspaceApiRef } from "@/web/workspace-url";
import { useWorkspace } from "./workspace-context";

/** The stored mark for this person in this workspace (null: never visited here). */
export function useLastVisitMark(): [string | null, (iso: string) => void] {
  const { address, currentUser } = useWorkspace();
  const ref = workspaceApiRef(address);
  // Lazy initial read so the first count already uses the stored mark (the
  // server render reads nothing: `lastVisit` is a no-op without `window`).
  const [mark, setMark] = useState<string | null>(() => lastVisit.get(currentUser.id, ref));
  useEffect(() => {
    const read = () => setMark(lastVisit.get(currentUser.id, ref));
    read();
    window.addEventListener(LAST_VISIT_EVENT, read);
    return () => window.removeEventListener(LAST_VISIT_EVENT, read);
  }, [currentUser.id, ref]);
  const update = useCallback((iso: string) => {
    lastVisit.set(currentUser.id, ref, iso);
    window.dispatchEvent(new CustomEvent(LAST_VISIT_EVENT));
  }, [currentUser.id, ref]);
  return [mark, update];
}

/** Bumps on every broadcast that can change the feed, debounced. */
export function useFeedTick(delayMs = 1500): number {
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTick((value) => value + 1), delayMs);
  }, [delayMs]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // The same events the Changes view listens to (`CHANGES_REALTIME_EVENTS`).
  useWorkspaceBroadcast("node.created", bump);
  useWorkspaceBroadcast("node.updated", bump);
  useWorkspaceBroadcast("node.renamed", bump);
  useWorkspaceBroadcast("node.moved", bump);
  useWorkspaceBroadcast("node.deleted", bump);
  useWorkspaceBroadcast("backlink.changed", bump);
  return tick;
}

/** One page of the feed since `since`, slim rows, newest first. */
export async function fetchChangesSince(
  workspaceRef: string,
  since: string,
): Promise<{ entries: ActivityEntry[]; more: boolean }> {
  const params = new URLSearchParams({
    workspace: workspaceRef,
    since,
    limit: String(WHATS_NEW_PAGE),
    fields: "list",
  });
  const response = await fetch(`/api/activity?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`activity ${response.status}`);
  const body = await response.json() as { changes: ActivityEntry[]; next_cursor: string | null };
  return { entries: body.changes, more: Boolean(body.next_cursor) };
}

/** Pending ingest candidates, as a number; 0 when the inbox cannot be read. */
export async function fetchPendingReviewCount(workspaceId: string): Promise<number> {
  try {
    const response = await fetch(`/api/ingest/stats?workspace_id=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) return 0;
    const body = await response.json() as { candidates?: Record<string, number> };
    return body.candidates?.pending ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The sidebar badge: changes since the last visit that were not the
 * viewer's own, plus ingest candidates waiting for a decision. `capped` is
 * true when the feed had more than one page, which the badge shows as 99+.
 */
export function useWhatsNewCount(): { count: number; capped: boolean } {
  const { address, workspace, currentUser } = useWorkspace();
  const [mark] = useLastVisitMark();
  const tick = useFeedTick();
  const [state, setState] = useState({ count: 0, capped: false });
  const ref = workspaceApiRef(address);
  const workspaceId = workspace?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [changes, pending] = await Promise.all([
        fetchChangesSince(ref, sinceFor(mark)).catch(() => ({ entries: [], more: false })),
        workspaceId ? fetchPendingReviewCount(workspaceId) : Promise.resolve(0),
      ]);
      if (cancelled) return;
      setState({ count: newChanges(changes.entries, currentUser.id).length + pending, capped: changes.more });
    })();
    return () => { cancelled = true; };
  }, [ref, workspaceId, mark, tick, currentUser.id]);

  return state;
}
