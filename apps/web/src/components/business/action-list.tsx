/**
 * A titled list of records to act on (accounts at risk, renewals, open
 * incidents…) for the business overview. Rows are `DashboardListRow`, so a
 * record opens in the node panel like any node on the dashboard.
 *
 * Who uses it: `business-overview.tsx`. Server component. `rows === null`
 * means the workspace has no record type for this list — the list is not
 * rendered at all, rather than claiming there is nothing to do.
 */
import { Separator } from "@heroui/react";
import { DashboardListRow } from "@/components/dashboard-list-row";
import { ItemCardGroup } from "@/components/ui/item-card";
import type { ActionRow } from "@/lib/business/overview";
import { nodeDeepLink } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

export function ActionList({
  ws,
  title,
  hint,
  rows,
  empty,
  limit = 5,
}: {
  ws: WorkspaceAddress;
  title: string;
  hint?: string;
  rows: ActionRow[] | null;
  empty: string;
  limit?: number;
}) {
  if (rows === null) return null;
  const shown = rows.slice(0, limit);
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {hint ? <span className="truncate text-xs text-muted">{hint}</span> : null}
        </div>
        {rows.length > limit ? <span className="shrink-0 text-xs text-muted">+{rows.length - limit} more</span> : null}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted">{empty}</p>
      ) : (
        <ItemCardGroup className="overflow-hidden">
          {shown.flatMap((row, index) => {
            const item = (
              <DashboardListRow
                key={row.id}
                href={nodeDeepLink(ws, row.id)}
                nodeId={row.id}
                kind={row.kind}
                title={row.title}
                chip={{ label: row.chip, color: row.tone ?? "default" }}
              />
            );
            return index === 0 ? [item] : [<Separator key={`sep-${row.id}`} />, item];
          })}
        </ItemCardGroup>
      )}
    </section>
  );
}
