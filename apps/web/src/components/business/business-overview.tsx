/**
 * The SaaS-first overview at `/w/<ws>` for b2b, b2c and marketplace
 * workspaces (a product workspace keeps the knowledge dashboard).
 *
 * Top row: the model's four headline KPIs (`TOP_KPIS`) with their honest
 * companions. Then the model's chart — MRR with its net-new movements, or
 * the marketplace's GMV and bookings — beside unit economics or marketplace
 * health and the month's expenses. Then the action lists, records to act on
 * today. At the bottom, the compact "What's being built" block.
 *
 * Who renders it: `app/w/[ws]/page.tsx`. Server component; reads through
 * `@/web/business` (the summary, record types and records, each cached per
 * request) and draws with `kpi-card`, `business-charts` (lazy recharts) and
 * `action-list`.
 *
 * Must not break: a workspace with no events yet gets an explanation of how
 * to send them, with the way to an ingest key — not an error, and not a row
 * of zeros. Action lists whose record type does not exist are not drawn.
 */
import { Card } from "@heroui/react";
import type { KpiValue, MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import type { BusinessSettings, RecordType } from "@bcontext-dev/contract/business/record-types";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  TOP_KPIS,
  accountsAtRisk,
  bugsAffectingCustomers,
  expensesByCategory,
  findRole,
  kpiMap,
  mrrMovementSeries,
  openIncidents,
  renewalsThisMonth,
  requestsBySegment,
  seasonSeries,
  summaryHasData,
  topRequestsByMrr,
  underSuppliedZones,
  weightedPipeline,
  type RecordRole,
} from "@/lib/business/overview";
import { formatKpiValue, formatMoney, periodLabel } from "@/lib/business/format";
import { businessModelLabel } from "@/lib/business/models";
import { getMetricsSummary, listRecordTypes, listRecords } from "@/web/business";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { ActionList } from "./action-list";
import { MrrChart, SeasonChart } from "./business-charts";
import { KnowledgeActivityBlock } from "./knowledge-activity-block";
import { KpiCard, KpiCardPlaceholder } from "./kpi-card";
import { OpenBusinessSettings } from "./open-business-settings";

type BusinessModelShown = Exclude<BusinessSettings["business_model"], "product">;

/** The roles each model's action lists read records of. */
const ROLES: Record<BusinessModelShown, RecordRole[]> = {
  b2b: ["customer", "deal", "request"],
  b2c: ["customer", "request"],
  marketplace: ["zone", "supplier", "incident", "request"],
};

export async function BusinessOverview({
  ws,
  settings,
  nodes,
  now,
}: {
  ws: WorkspaceAddress;
  settings: BusinessSettings & { business_model: BusinessModelShown };
  nodes: readonly KnowledgeNode[];
  now: Date;
}) {
  const model = settings.business_model;
  const [summary, types] = await Promise.all([getMetricsSummary(ws), listRecordTypes(ws)]);
  const currency = summary?.currency ?? settings.currency;
  const money = (amount: number) => formatMoney(amount, currency);

  // One read per role that exists; node-stored types only (dataset rows are
  // not pages to open from a list).
  const roleTypes = new Map<RecordRole, RecordType>();
  for (const role of ROLES[model]) {
    const type = findRole(types.filter((t) => t.storage === "node"), role);
    if (type) roleTypes.set(role, type);
  }
  const recordsByRole = new Map<RecordRole, KnowledgeNode[]>(
    await Promise.all([...roleTypes.entries()].map(async ([role, type]) => [role, await listRecords(ws, type.key)] as const)),
  );
  const of = (role: RecordRole) => recordsByRole.get(role) ?? [];
  const typeOf = (role: RecordRole) => roleTypes.get(role) ?? null;

  const hasData = summaryHasData(summary);
  const kpis = kpiMap(summary);

  return (
    <div className="scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-8 sm:pt-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 px-0.5">
          <h1 className="text-[15px] font-medium text-foreground">
            {businessModelLabel(model)} · {summary ? periodLabel(summary.current_period, { year: true }) : "this month"}
          </h1>
          <span className="text-xs text-muted">
            {summary?.computed_at ? `Metrics as of ${new Date(summary.computed_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : null}
            {" · "}
            {currency}
          </span>
        </div>

        {hasData ? (
          <>
            <TopRow summary={summary!} model={model} currency={currency} />
            {model === "marketplace" ? (
              <MarketplaceMiddle summary={summary!} currency={currency} kpis={kpis} />
            ) : (
              <SaasMiddle summary={summary!} currency={currency} kpis={kpis} />
            )}
          </>
        ) : (
          <NoDataYet model={model} />
        )}

        {model === "marketplace" ? (
          <MarketplaceLists ws={ws} roles={{ of, typeOf }} />
        ) : (
          <SaasLists ws={ws} model={model} roles={{ of, typeOf }} types={types} nodes={nodes} now={now} money={money} />
        )}

        <KnowledgeActivityBlock ws={ws} nodes={nodes} now={now} />
      </div>
    </div>
  );
}

function TopRow({ summary, model, currency }: { summary: MetricsSummary; model: BusinessModelShown; currency: string }) {
  const kpis = kpiMap(summary);
  return (
    <section aria-label="Key figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {TOP_KPIS[model].map((top) => {
        const kpi = kpis.get(top.key);
        if (!kpi) return <KpiCardPlaceholder key={top.key} label={top.key} />;
        const secondary = top.secondary.map((key) => kpis.get(key)).filter((k): k is KpiValue => Boolean(k));
        return <KpiCard key={top.key} kpi={kpi} secondary={secondary} currency={currency} yoy={top.yoy} />;
      })}
    </section>
  );
}

function SaasMiddle({ summary, currency, kpis }: { summary: MetricsSummary; currency: string; kpis: Map<string, KpiValue> }) {
  return (
    <div className="mt-5 grid gap-5 lg:grid-cols-3">
      <Card className="rounded-2xl lg:col-span-2">
        <Card.Header className="pb-0">
          <h2 className="text-[15px] font-medium text-foreground">MRR</h2>
          <p className="text-xs text-muted">Last 12 months · bars are the month&apos;s new, expansion, contraction and churned MRR</p>
        </Card.Header>
        <Card.Content>
          <MrrChart data={mrrMovementSeries(summary)} currency={currency} />
        </Card.Content>
      </Card>
      <Card className="rounded-2xl">
        <Card.Header className="pb-0">
          <h2 className="text-[15px] font-medium text-foreground">Unit economics</h2>
        </Card.Header>
        <Card.Content className="space-y-4">
          <FigureList items={["nrr", "arpa", "expenses"].map((key) => kpis.get(key)).filter(Boolean) as KpiValue[]} currency={currency} />
          <ExpenseBars summary={summary} currency={currency} />
        </Card.Content>
      </Card>
    </div>
  );
}

function MarketplaceMiddle({ summary, currency, kpis }: { summary: MetricsSummary; currency: string; kpis: Map<string, KpiValue> }) {
  return (
    <div className="mt-5 grid gap-5 lg:grid-cols-3">
      <Card className="rounded-2xl lg:col-span-2">
        <Card.Header className="pb-0">
          <h2 className="text-[15px] font-medium text-foreground">GMV and bookings</h2>
          <p className="text-xs text-muted">Last 12 months · the GMV card compares with the same month last season</p>
        </Card.Header>
        <Card.Content>
          <SeasonChart data={seasonSeries(summary)} currency={currency} />
        </Card.Content>
      </Card>
      <Card className="rounded-2xl">
        <Card.Header className="pb-0">
          <h2 className="text-[15px] font-medium text-foreground">Marketplace health</h2>
        </Card.Header>
        <Card.Content className="space-y-4">
          <FigureList
            items={["active_suppliers", "active_buyers", "new_buyers", "repeat_buyer_rate"].map((key) => kpis.get(key)).filter(Boolean) as KpiValue[]}
            currency={currency}
          />
          <ExpenseBars summary={summary} currency={currency} />
        </Card.Content>
      </Card>
    </div>
  );
}

/** Label · value rows, each with its definition on hover. */
function FigureList({ items, currency }: { items: KpiValue[]; currency: string }) {
  return (
    <dl className="divide-y divide-border">
      {items.map((kpi) => (
        <div key={kpi.key} className="flex items-baseline justify-between gap-3 py-1.5" title={kpi.definition}>
          <dt className="text-[12.5px] text-muted">{kpi.label}</dt>
          <dd className="text-[14px] font-medium tabular-nums text-foreground">{formatKpiValue(kpi.unit, kpi.current, currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The month's expenses by category as plain bars: no chart library for five rows. */
function ExpenseBars({ summary, currency }: { summary: MetricsSummary; currency: string }) {
  const rows = expensesByCategory(summary);
  if (rows.length === 0) return null;
  const max = rows[0]!.amount;
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-muted">Expenses by category</div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.category} className="grid grid-cols-[72px_1fr_auto] items-center gap-2 text-[12px]">
            <span className="truncate capitalize text-muted">{row.category}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-default/40">
              <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(4, (row.amount / max) * 100)}%` }} />
            </span>
            <span className="tabular-nums text-foreground">{formatMoney(row.amount, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Roles {
  of: (role: RecordRole) => KnowledgeNode[];
  typeOf: (role: RecordRole) => RecordType | null;
}

function SaasLists({
  ws,
  model,
  roles,
  types,
  nodes,
  now,
  money,
}: {
  ws: WorkspaceAddress;
  model: "b2b" | "b2c";
  roles: Roles;
  types: RecordType[];
  nodes: readonly KnowledgeNode[];
  now: Date;
  money: (amount: number) => string;
}) {
  const customers = roles.of("customer");
  const customerType = roles.typeOf("customer");
  const records = [...customers, ...roles.of("deal"), ...roles.of("request")];
  const pipeline = model === "b2b" ? weightedPipeline(roles.of("deal"), roles.typeOf("deal"), money) : null;
  return (
    <div className="mt-8 grid gap-5 lg:grid-cols-2">
      <ActionList ws={ws} title={`${customerType?.label_plural ?? "Accounts"} at risk`} hint="by MRR" rows={accountsAtRisk(customers, customerType, money)} empty="Nobody is flagged at risk." />
      <ActionList ws={ws} title="Renewals this month" rows={renewalsThisMonth(customers, customerType, now)} empty="No renewals this month." />
      <ActionList
        ws={ws}
        title="Top requests"
        hint="by MRR asking"
        rows={topRequestsByMrr(roles.of("request"), roles.typeOf("request"), customers, customerType, money)}
        empty="No open requests linked to customers."
      />
      <ActionList
        ws={ws}
        title="Open bugs affecting customers"
        rows={bugsAffectingCustomers(nodes.filter((n) => n.kind === "bug"), records, types, customerType?.key ?? null)}
        empty="No open bug is linked to a customer."
      />
      {pipeline ? (
        <section aria-label="Weighted pipeline" className="min-w-0 lg:col-span-2">
          <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
            <h2 className="text-sm font-medium text-foreground">Weighted pipeline</h2>
            <span className="text-xs text-muted">
              {money(pipeline.weighted)} weighted · {money(pipeline.total)} open
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {pipeline.stages.map((stage) => (
              <div key={stage.stage} className="rounded-xl border border-border bg-[var(--paper-2)] px-3 py-2">
                <div className="truncate text-[12px] capitalize text-muted">{stage.stage.replace(/_/g, " ")}</div>
                <div className="text-[15px] font-semibold tabular-nums text-foreground">{money(stage.weighted)}</div>
                <div className="text-[11.5px] text-muted">{stage.count} deals · {money(stage.value)}</div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <ActionList ws={ws} title="Biggest open deals" rows={pipeline.deals} empty="No open deals." />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MarketplaceLists({ ws, roles }: { ws: WorkspaceAddress; roles: Roles }) {
  const segments = requestsBySegment(roles.of("request"), roles.typeOf("request"));
  return (
    <div className="mt-8 grid gap-5 lg:grid-cols-2">
      <ActionList
        ws={ws}
        title="Zones with demand and few suppliers"
        rows={underSuppliedZones(roles.of("zone"), roles.typeOf("zone"), roles.of("supplier"), roles.typeOf("supplier"))}
        empty="Every zone with demand has supply."
      />
      <ActionList ws={ws} title="Open incidents" rows={openIncidents(roles.of("incident"), roles.typeOf("incident"))} empty="No open incidents." />
      {segments ? (
        <section aria-label="Requests by segment" className="min-w-0">
          <h2 className="mb-2 px-0.5 text-sm font-medium text-foreground">Requests by segment</h2>
          {segments.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {segments.map((row) => (
                <li key={row.segment} className="flex items-center justify-between px-4 py-2 text-[13px]">
                  <span className="capitalize text-foreground">{row.segment.replace(/_/g, " ")}</span>
                  <span className="tabular-nums text-muted">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** Before the first event: what to send and where the key is. Not an error. */
function NoDataYet({ model }: { model: BusinessModelShown }) {
  const what = model === "marketplace"
    ? "booking.created, booking.completed and booking.canceled for every booking"
    : "subscription.started, subscription.changed and subscription.canceled for every customer";
  return (
    <section aria-label="No business data yet" className="rounded-2xl border border-dashed border-border px-6 py-8">
      <h2 className="text-[15px] font-medium text-foreground">No business data yet</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-[1.6] text-muted">
        The figures here are computed from events your app sends: {what}, plus expense.recorded and
        cash.balance for net, burn and runway. Create an ingest key, send a first event, and this page
        fills in on the next rollup.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-[13px]">
        <OpenBusinessSettings section="ingest-keys">Create an ingest key</OpenBusinessSettings>
        <OpenBusinessSettings section="record-types" className="text-muted underline underline-offset-2 hover:text-foreground">
          Review the record types
        </OpenBusinessSettings>
      </div>
    </section>
  );
}
