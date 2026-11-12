"use client";

/**
 * The business timeline of one subject — what the app said happened to an
 * account, a customer or a supplier ("Subscribed at €200/mo", "Plan changed
 * to €450/mo", "Booking canceled"), newest first.
 *
 * For the account 360 page and any panel that shows a record: pass the
 * record's type and its external id (the id the app uses — `data.external_id`
 * on a node record, the row key of a dataset record). Reads
 * `GET /api/workspaces/:ws/timeline`; events are facts appended by the ingest
 * API, so there is nothing to edit here.
 */
import { useEffect, useState } from "react";
import { Button, Skeleton } from "@heroui/react";
import { businessEventTone, describeBusinessEvent, type BusinessTimelineResponse } from "@bcontext-dev/contract/business/timeline";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { loadTimeline } from "@/lib/business/requests";
import type { WorkspaceAddress } from "@/web/workspace-url";

const PAGE = 50;

export function BusinessTimeline({
  workspace,
  subjectType,
  subjectId,
  className,
}: {
  workspace: WorkspaceAddress;
  subjectType?: string | null;
  subjectId: string;
  className?: string;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: BusinessTimelineResponse }>({ status: "loading" });

  useEffect(() => {
    let live = true;
    void loadTimeline(workspace, { type: subjectType, id: subjectId }, limit).then((loaded) => {
      if (!live) return;
      setState(loaded.ok ? { status: "ready", data: loaded.data } : { status: "error", message: loaded.message });
    });
    return () => {
      live = false;
    };
  }, [workspace, subjectType, subjectId, limit]);

  if (state.status === "loading") {
    return (
      <div className={cn("flex flex-col gap-2", className)} role="status" aria-label="Loading timeline">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
      </div>
    );
  }
  if (state.status === "error") return <p className={cn("text-[12px] text-[var(--ink-3)]", className)}>{state.message}</p>;
  const { events, more } = state.data;
  if (events.length === 0) return <p className={cn("text-[12px] text-[var(--ink-3)]", className)}>No business events for this {subjectType ?? "subject"} yet.</p>;

  return (
    <div className={cn("flex flex-col", className)}>
      <ol className="m-0 flex list-none flex-col p-0">
        {events.map((event) => {
          const tone = businessEventTone(event);
          return (
            <li key={event.id} className="relative flex gap-3 pb-3 pl-1 last:pb-0">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  tone === "positive" ? "bg-[var(--accent)]" : tone === "negative" ? "bg-[var(--warn)]" : "bg-[var(--ink-mute)]",
                )}
              />
              <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                <span className="truncate text-[12.5px] text-[var(--ink)]">{describeBusinessEvent(event)}</span>
                <time dateTime={event.occurred_at} title={new Date(event.occurred_at).toLocaleString()} className="shrink-0 text-[11px] tabular-nums text-[var(--ink-mute)]">
                  {formatRelative(event.occurred_at)}
                </time>
              </div>
            </li>
          );
        })}
      </ol>
      {more ? (
        <Button size="sm" variant="ghost" className="mt-2 self-start text-[11.5px]" onPress={() => setLimit((n) => n + PAGE)}>
          Show older
        </Button>
      ) : null}
    </div>
  );
}
