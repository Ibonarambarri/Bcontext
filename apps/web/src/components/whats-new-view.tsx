"use client";

/**
 * "What's new" — the workspace's review surface at `/w/<ws>/v/updates`,
 * rendered by `v/[view]/page.tsx`. Agents write the brain; this is where a
 * person reads what they wrote since their last visit.
 *
 * Two parts, in this order:
 *   1. Needs review — ingest candidates waiting for accept/dismiss (the
 *      existing `/api/ingest/candidates/:id/{accept,dismiss}` routes, shown
 *      only to someone who may write), changes whose writer asked for a
 *      review, and decisions created since the last visit.
 *   2. Everything else since the last visit, grouped by who did it and then
 *      by the node it touched.
 *
 * It is a lens over the existing Changes feed (`GET /api/activity`), not a
 * feed of its own: the full history with diffs stays in Activity, which this
 * view links to. Nothing here offers undo — the feed has no audited
 * compensation contract (`revert.available` is always false).
 *
 * The last-visit mark (per user and workspace, in this browser — see
 * `lastVisit` in `local-settings.ts`) moves when the person leaves the view
 * or presses "Mark all as seen", to the later of when they opened it and
 * the newest change it loaded. Moving it on open would empty the list the
 * moment they look at it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
  ExternalLink,
  Inbox,
  RefreshCw,
  Settings2,
  UserRound,
  X,
} from "lucide-react";
import { Button, Chip, Spinner, Tooltip } from "@heroui/react";
import type { ActivityEntry } from "@bcontext-dev/contract/activity";
import type { IngestCandidate } from "@bcontext-dev/contract/ingest";
import { formatRelative } from "@bcontext-dev/contract/utils";
import { ListSkeleton } from "@/components/skeletons";
import { NODE_KIND_ICONS } from "./node-kind-icon";
import { lastVisit } from "@/lib/local-settings";
import { systemViewPath } from "@/lib/view-shell";
import {
  groupByActor,
  newChanges,
  newDecisions,
  newestTs,
  pendingReviews,
  sinceFor,
  type ActorGroup,
} from "@/lib/whats-new";
import { workspaceApiRef } from "@/web/workspace-url";
import { fetchChangesSince, useFeedTick, useLastVisitMark } from "./whats-new-data";
import { useWorkspace } from "./workspace-context";

export function WhatsNewView() {
  const { address, workspace, currentUser, nodes, selectNode, toast } = useWorkspace();
  const ref = workspaceApiRef(address);
  const workspaceId = workspace?.id ?? null;
  const canWrite = workspace ? workspace.role !== "viewer" : false;
  const [, setMark] = useLastVisitMark();
  const tick = useFeedTick();

  // The window this visit shows is fixed when the view opens, so moving the
  // mark (on leave) never empties the list under the reader's eyes. Read
  // after mount: storage is this browser's, and the server render has none.
  const [since, setSince] = useState<string | null>(null);
  const openedAt = useRef(new Date().toISOString());
  useEffect(() => {
    setSince((current) => current ?? sinceFor(lastVisit.get(currentUser.id, ref)));
  }, [currentUser.id, ref]);

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [more, setMore] = useState(false);
  const [candidates, setCandidates] = useState<IngestCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Only a visit that actually showed the changes may mark them as seen.
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (!since) return;
    try {
      const [changes, inbox] = await Promise.all([
        fetchChangesSince(ref, since),
        workspaceId ? fetchPendingCandidates(workspaceId) : Promise.resolve([]),
      ]);
      setEntries(changes.entries);
      setMore(changes.more);
      setCandidates(inbox);
      setError(null);
      loaded.current = true;
    } catch {
      setError("What's new could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [ref, since, workspaceId]);

  useEffect(() => { void load(); }, [load, tick]);

  // Leaving the view is "I have seen this": the mark moves to the later of
  // when it opened and the newest change it loaded.
  const seenUpTo = useRef<string>(openedAt.current);
  useEffect(() => {
    const newest = newestTs(entries);
    if (newest && newest > seenUpTo.current) seenUpTo.current = newest;
  }, [entries]);
  const setMarkRef = useRef(setMark);
  setMarkRef.current = setMark;
  useEffect(() => {
    const commit = () => { if (loaded.current) setMarkRef.current(seenUpTo.current); };
    window.addEventListener("pagehide", commit);
    return () => {
      window.removeEventListener("pagehide", commit);
      commit();
    };
  }, []);

  const markAllSeen = useCallback(() => {
    const now = new Date().toISOString();
    seenUpTo.current = now;
    setMark(now);
    setSince(now);
    setEntries([]);
    setMore(false);
  }, [setMark]);

  const visible = useMemo(() => newChanges(entries, currentUser.id), [entries, currentUser.id]);
  const decisions = useMemo(() => newDecisions(visible), [visible]);
  const reviews = useMemo(() => pendingReviews(visible), [visible]);
  const groups = useMemo(() => groupByActor(visible), [visible]);
  const knownNodes = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const open = useCallback((nodeId: string | null) => {
    if (nodeId && knownNodes.has(nodeId)) selectNode(nodeId);
  }, [knownNodes, selectNode]);

  const resolveCandidate = useCallback(async (candidate: IngestCandidate, op: "accept" | "dismiss") => {
    if (!workspaceId) return;
    setBusy((current) => ({ ...current, [candidate.id]: true }));
    try {
      const response = await fetch(`/api/ingest/candidates/${encodeURIComponent(candidate.id)}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = await response.json().catch(() => null) as { candidate?: IngestCandidate; message?: string; error?: unknown } | null;
      if (!response.ok) {
        toast.error(body?.message ?? (typeof body?.error === "string" ? body.error : `Could not ${op} this proposal.`));
        return;
      }
      setCandidates((current) => current.filter((item) => item.id !== candidate.id));
      if (op === "accept") {
        toast.info(`Added “${candidate.title}”.`);
        if (body?.candidate?.created_node_id) selectNode(body.candidate.created_node_id);
      } else {
        toast.info("Proposal dismissed.");
      }
    } catch {
      toast.error(`Could not ${op} this proposal.`);
    } finally {
      setBusy((current) => ({ ...current, [candidate.id]: false }));
    }
  }, [workspaceId, toast, selectNode]);

  const needsReviewCount = candidates.length + reviews.length + decisions.length;
  const nothing = !loading && !error && visible.length === 0 && candidates.length === 0;

  return (
    <div className="scroll h-full overflow-y-auto" role="region" aria-label="What's new">
      <div className="mx-auto max-w-4xl px-4 pb-16 pt-4 sm:px-8 sm:pt-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">
            {since ? <>Since your last visit · <time dateTime={since}>{formatRelative(since)}</time></> : "Since your last visit"}
          </p>
          <div className="flex items-center gap-2">
            <Tooltip delay={0}>
              <Button isIconOnly size="sm" variant="ghost" aria-label="Refresh" onPress={() => void load()}>
                <RefreshCw size={14} />
              </Button>
              <Tooltip.Content><p>Refresh</p></Tooltip.Content>
            </Tooltip>
            <Button size="sm" variant="secondary" isDisabled={visible.length === 0} onPress={markAllSeen}>
              <CheckCheck size={14} /> Mark all as seen
            </Button>
          </div>
        </header>

        {error ? (
          <Notice>{error}</Notice>
        ) : loading ? (
          <ListSkeleton rows={6} label="Loading what's new" />
        ) : nothing ? (
          <Notice>
            <span>Nothing new since your last visit.</span>
            <Link href={systemViewPath(address, "changes")} className="inline-flex items-center gap-1 underline underline-offset-2">
              Full history in Activity <ArrowRight size={12} />
            </Link>
          </Notice>
        ) : (
          <>
            {needsReviewCount > 0 && (
              <section aria-label="Needs review" className="mb-8">
                <SectionTitle icon={<Inbox size={14} />} title="Needs review" count={needsReviewCount} />
                <ul className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--paper)]">
                  {candidates.map((candidate) => (
                    <ReviewRow
                      key={`c-${candidate.id}`}
                      kind={candidate.kind}
                      label="Proposed"
                      title={candidate.title}
                      meta={`from ${candidate.source}${candidate.confidence != null ? ` · ${Math.round(candidate.confidence * 100)}% confident` : ""}`}
                      ts={candidate.created_at}
                    >
                      {canWrite ? (
                        <>
                          <Button size="sm" variant="secondary" isDisabled={busy[candidate.id]} onPress={() => void resolveCandidate(candidate, "accept")}>
                            {busy[candidate.id] ? <Spinner size="sm" /> : <Check size={13} />} Accept
                          </Button>
                          <Button size="sm" variant="ghost" isDisabled={busy[candidate.id]} onPress={() => void resolveCandidate(candidate, "dismiss")}>
                            <X size={13} /> Dismiss
                          </Button>
                        </>
                      ) : null}
                    </ReviewRow>
                  ))}
                  {reviews.map((entry) => (
                    <ReviewRow
                      key={`r-${entry.id}`}
                      kind={entry.node_kind}
                      label={entry.review?.label ?? "Review"}
                      title={entry.node_title ?? entry.summary ?? "Change"}
                      meta={`${actorName(entry)} · ${entry.action}`}
                      ts={entry.ts}
                    >
                      {entry.review?.review_url && canWrite ? (
                        <a href={entry.review.review_url} className="inline-flex items-center gap-1 text-[12px] underline underline-offset-2">
                          Review <ExternalLink size={11} />
                        </a>
                      ) : null}
                      <OpenButton nodeId={entry.node_id} known={knownNodes} onOpen={open} />
                    </ReviewRow>
                  ))}
                  {decisions.map((entry) => (
                    <ReviewRow
                      key={`d-${entry.id}`}
                      kind={entry.node_kind}
                      label="New decision"
                      title={entry.node_title ?? "Decision"}
                      meta={actorName(entry)}
                      ts={entry.ts}
                    >
                      <OpenButton nodeId={entry.node_id} known={knownNodes} onOpen={open} />
                    </ReviewRow>
                  ))}
                </ul>
              </section>
            )}

            {groups.length > 0 && (
              <section aria-label="Changes by author">
                <SectionTitle title="Changes" count={visible.length} />
                <div className="space-y-4">
                  {groups.map((group) => (
                    <ActorCard key={group.key} group={group} known={knownNodes} onOpen={open} />
                  ))}
                </div>
              </section>
            )}

            {more && (
              <p className="mt-4 text-[12px] text-muted">
                Showing the latest {visible.length}.{" "}
                <Link href={systemViewPath(address, "changes")} className="underline underline-offset-2">
                  The rest is in Activity
                </Link>
                .
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

async function fetchPendingCandidates(workspaceId: string): Promise<IngestCandidate[]> {
  try {
    const response = await fetch(
      `/api/ingest/candidates?workspace_id=${encodeURIComponent(workspaceId)}&status=pending`,
      { cache: "no-store" },
    );
    if (!response.ok) return [];
    const body = await response.json() as { candidates?: IngestCandidate[] };
    return body.candidates ?? [];
  } catch {
    // The inbox is a bonus on this page; the changes still show without it.
    return [];
  }
}

function actorName(entry: ActivityEntry): string {
  return entry.actor?.name?.trim() || entry.actor_label;
}

function SectionTitle({ title, count, icon }: { title: string; count: number; icon?: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 px-0.5 text-sm font-medium text-foreground">
      {icon}
      {title}
      <Chip size="sm" variant="soft">{count}</Chip>
    </h2>
  );
}

function ReviewRow({
  kind,
  label,
  title,
  meta,
  ts,
  children,
}: {
  kind: string | null;
  label: string;
  title: string;
  meta: string;
  ts: string;
  children?: React.ReactNode;
}) {
  const Icon = (kind && NODE_KIND_ICONS[kind as keyof typeof NODE_KIND_ICONS]) || Settings2;
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-3">
      <Icon size={15} className="shrink-0 text-[var(--ink-3)]" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="mono shrink-0 text-[10px] uppercase tracking-wider text-[var(--ink-mute)]">{label}</span>
          <span className="truncate text-[13px] text-[var(--ink)]">{title}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted">
          {meta} · <time dateTime={ts}>{formatRelative(ts)}</time>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </li>
  );
}

function OpenButton({ nodeId, known, onOpen }: { nodeId: string | null; known: Set<string>; onOpen: (id: string | null) => void }) {
  if (!nodeId || !known.has(nodeId)) return null;
  return (
    <Button size="sm" variant="ghost" onPress={() => onOpen(nodeId)}>
      Open
    </Button>
  );
}

function ActorCard({ group, known, onOpen }: { group: ActorGroup; known: Set<string>; onOpen: (id: string | null) => void }) {
  const ActorIcon = group.kind === "agent" ? Bot : group.kind === "human" ? UserRound : Settings2;
  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--paper)]">
      <header className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <ActorIcon size={15} className="shrink-0 text-[var(--ink-3)]" />
        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--ink)]">{group.name}</span>
        {group.kind && <span className="mono text-[10px] uppercase tracking-wider text-[var(--ink-mute)]">{group.kind}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {group.count} {group.count === 1 ? "change" : "changes"} · <time dateTime={group.latest}>{formatRelative(group.latest)}</time>
        </span>
      </header>
      <ul className="divide-y divide-[var(--line)]">
        {group.nodes.map((node) => {
          const Icon = (node.node_kind && NODE_KIND_ICONS[node.node_kind]) || Settings2;
          const openable = Boolean(node.node_id && known.has(node.node_id));
          const body = (
            <>
              <Icon size={14} className="shrink-0 text-[var(--ink-3)]" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">{node.title}</span>
              <span className="shrink-0 text-[11px] text-muted">
                {node.actions.join(" · ")}
                {node.entries.length > 1 ? ` ×${node.entries.length}` : ""}
              </span>
              <time dateTime={node.latest} className="w-16 shrink-0 text-right text-[11px] text-muted">{formatRelative(node.latest)}</time>
            </>
          );
          return (
            <li key={node.key}>
              {openable ? (
                <button
                  type="button"
                  data-node-id={node.node_id ?? undefined}
                  onClick={() => onOpen(node.node_id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--paper-2)]"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line)] text-center text-[13px] text-[var(--ink-3)]">
      {children}
    </div>
  );
}
