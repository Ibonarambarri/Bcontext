/**
 * The 360 layout of a hub record — a customer, a supplier, a zone: the
 * records other types point at. KPIs and MRR history when it has
 * subscription events, then everything related to it grouped by kind
 * (contacts, deals, requests, tickets, bugs, decisions…), then its business
 * event timeline.
 *
 * Who renders it: `app/w/[ws]/n/[nodeId]/page.tsx`, under the record header,
 * when `isHubType` says other record types relate to this one. Nothing here
 * says `account`: the groups come from the workspace's relation fields and
 * the links the knowledge graph already has (`relatedGroups`), so a
 * marketplace's supplier gets the same page shape as a B2B account.
 *
 * Server component. Reads: the inspector payload (mentions and edges), the
 * records of every type that relates to this one, and the subject's events
 * (by its external id) — all through the API, all tolerant of a missing
 * route (an empty section rather than a broken page).
 */
import { Card } from "@heroui/react";
import type { NodeInspectorPayload } from "@bcontext-dev/contract/node-inspector";
import type { RecordType } from "@bcontext-dev/contract/business/record-types";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { DashboardListRow } from "@/components/dashboard-list-row";
import { formatMoney } from "@/lib/business/format";
import {
  externalIdOf,
  mrrHistory,
  relatedGroups,
  relationFieldsTo,
} from "@/lib/business/records";
import { nodeDeepLink } from "@/lib/view-shell";
import { apiJsonOrNull } from "@/web/api-client";
import { listRecords, listSubjectEvents } from "@/web/business";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { MrrChart } from "./business-charts";
import { EventTimeline } from "./event-timeline";

export async function Record360({
  ws,
  node,
  type,
  types,
  index,
  currency,
  now,
}: {
  ws: WorkspaceAddress;
  node: KnowledgeNode;
  type: RecordType;
  types: RecordType[];
  index: readonly KnowledgeNode[];
  currency: string;
  now: Date;
}) {
  // Types that point here, plus types this record points at: their records
  // carry the relation fields the groups are built from.
  const relatedKeys = new Set<string>();
  for (const other of types) {
    if (other.storage !== "node") continue;
    if (other.key !== type.key && relationFieldsTo(other, type.key).length > 0) relatedKeys.add(other.key);
    if (relationFieldsTo(type, other.key).length > 0) relatedKeys.add(other.key);
  }
  const externalId = externalIdOf(node);
  const [inspector, recordLists, events] = await Promise.all([
    apiJsonOrNull<NodeInspectorPayload>(
      `/api/nodes/${encodeURIComponent(node.id)}/inspector?workspace=${encodeURIComponent(workspaceApiRef(ws))}`,
    ).catch(() => null),
    Promise.all([...relatedKeys].map((key) => listRecords(ws, key))),
    externalId ? listSubjectEvents(ws, type.key, externalId) : Promise.resolve([]),
  ]);

  const links = [
    ...(inspector?.backlinks ?? []).map((link) => ({ id: link.id, kind: link.kind, title: link.title, via: "mentions it" })),
    ...(inspector?.forward_links ?? []).map((link) => ({ id: link.id, kind: link.kind, title: link.title, via: "mentioned" })),
    ...(inspector?.relations ?? []).map((rel) => ({ id: rel.node_id, kind: rel.kind, title: rel.title, via: rel.direction === "incoming" ? "linked from" : "links to" })),
  ];
  const groups = relatedGroups({
    node,
    type,
    types,
    records: recordLists.flat(),
    links,
    index: new Map(index.map((n) => [n.id, { kind: n.kind, title: n.title, status: n.status }])),
  });

  const hasSubscriptions = events.some((event) => event.type.startsWith("subscription."));
  const history = hasSubscriptions ? mrrHistory(events, currency, now) : [];
  const current = history.at(-1)?.mrr ?? null;
  const yearAgo = history[0]?.mrr ?? null;

  return (
    <div className="mt-4 space-y-5">
      {hasSubscriptions ? (
        <Card className="rounded-2xl">
          <Card.Header className="flex-row flex-wrap items-baseline gap-x-6 gap-y-1 pb-0">
            <div>
              <div className="text-[12px] text-muted">MRR</div>
              <div className="text-[22px] font-semibold tabular-nums text-foreground">{formatMoney(current, currency)}</div>
            </div>
            <div>
              <div className="text-[12px] text-muted">12 months ago</div>
              <div className="text-[15px] tabular-nums text-foreground">{formatMoney(yearAgo, currency)}</div>
            </div>
            <div>
              <div className="text-[12px] text-muted">Annualised</div>
              <div className="text-[15px] tabular-nums text-foreground">{formatMoney(current === null ? null : current * 12, currency)}</div>
            </div>
          </Card.Header>
          <Card.Content>
            <MrrChart
              height={180}
              currency={currency}
              data={history.map((point) => ({
                period: point.period,
                label: point.period.slice(5),
                mrr: point.mrr,
                new_mrr: 0,
                expansion_mrr: 0,
                contraction_mrr: 0,
                churned_mrr: 0,
              }))}
            />
          </Card.Content>
        </Card>
      ) : null}

      {groups.length > 0 ? (
        <div className="grid gap-5 md:grid-cols-2">
          {groups.map((group) => (
            <section key={group.kind} aria-label={group.label} className="min-w-0">
              <h2 className="mb-1.5 px-0.5 text-sm font-medium text-foreground">
                {group.label} <span className="text-xs font-normal text-muted">{group.items.length}</span>
              </h2>
              <div className="overflow-hidden rounded-2xl border border-border">
                {group.items.slice(0, 8).map((item) => (
                  <DashboardListRow
                    key={item.id}
                    href={nodeDeepLink(ws, item.id)}
                    nodeId={item.id}
                    kind={item.kind}
                    title={item.title}
                    chip={item.stage || item.status ? { label: (item.stage ?? item.status ?? "").replace(/_/g, " ") } : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {externalId ? (
        <section aria-label="Business events">
          <h2 className="mb-2 px-0.5 text-sm font-medium text-foreground">Events</h2>
          <EventTimeline events={events} currency={currency} />
        </section>
      ) : null}
    </div>
  );
}
