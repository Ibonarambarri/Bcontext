/**
 * "What's being built" — the compact knowledge activity block at the bottom
 * of a business workspace's overview: the latest tasks, bugs, decisions and
 * docs, with what changed and shipped this week.
 *
 * Who uses it: `business-overview.tsx`. Kept as its own component on
 * purpose: the read-first overview work shapes the knowledge activity too,
 * and a separate block is something both can render without editing each
 * other's page. Server component; rows open in the node panel through
 * `DashboardListRow`, like every other dashboard row.
 */
import { Separator } from "@heroui/react";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { DashboardListRow } from "@/components/dashboard-list-row";
import { ItemCardGroup } from "@/components/ui/item-card";
import { buildingNow } from "@/lib/business/overview";
import { nodeDeepLink } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

const DAY_MS = 86_400_000;

export function KnowledgeActivityBlock({ ws, nodes, now }: { ws: WorkspaceAddress; nodes: readonly KnowledgeNode[]; now: Date }) {
  const model = buildingNow(nodes, now);
  if (model.items.length === 0) return null;
  return (
    <section aria-label="What's being built" className="mt-10">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="text-sm font-medium text-foreground">What&apos;s being built</h2>
        <span className="text-xs text-muted">
          {model.changedThisWeek} changed · {model.shippedThisWeek} shipped this week
        </span>
      </div>
      <ItemCardGroup className="overflow-hidden">
        {model.items.flatMap((node, index) => {
          const days = Math.max(0, Math.round((now.getTime() - Date.parse(node.updated_at)) / DAY_MS));
          const row = (
            <DashboardListRow
              key={node.id}
              href={nodeDeepLink(ws, node.id)}
              nodeId={node.id}
              kind={node.kind}
              title={node.title}
              chip={{ label: days === 0 ? "today" : `${days}d` }}
            />
          );
          return index === 0 ? [row] : [<Separator key={`sep-${node.id}`} />, row];
        })}
      </ItemCardGroup>
    </section>
  );
}
