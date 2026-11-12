import { describe, expect, it } from "vitest";
import { KPI_DEFINITIONS, type KpiValue, type MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import type { RecordTypeDefinition } from "@bcontext-dev/contract/business/record-types";
import {
  TOP_KPIS,
  accountsAtRisk,
  bugsAffectingCustomers,
  buildingNow,
  expensesByCategory,
  findRole,
  mrrMovementSeries,
  openIncidents,
  renewalsThisMonth,
  requestsBySegment,
  summaryHasData,
  topRequestsByMrr,
  underSuppliedZones,
  weightedPipeline,
} from "./overview";
import type { RecordNodeLike } from "./records";

const money = (n: number) => `€${n}`;

const account: RecordTypeDefinition = {
  key: "account",
  label: "Account",
  storage: "node",
  fields: [
    { key: "mrr", label: "MRR", type: "money" },
    { key: "health", label: "Health", type: "select", options: ["good", "at_risk"] },
    { key: "renewal_date", label: "Renewal", type: "date" },
    { key: "requests", label: "Requests", type: "relation", target: "request", multiple: true },
  ],
};
const request: RecordTypeDefinition = {
  key: "request",
  label: "Request",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "stage", label: "Stage", type: "select", options: ["open", "planned", "done"] },
    { key: "accounts", label: "Accounts", type: "relation", target: "account", multiple: true },
    { key: "bug", label: "Bug", type: "relation", target: "bug" },
    { key: "segment", label: "Segment", type: "select", options: ["buyers", "suppliers"] },
  ],
};
const deal: RecordTypeDefinition = {
  key: "deal",
  label: "Deal",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "stage", label: "Stage", type: "select", options: ["lead", "trial", "proposal", "won", "lost"] },
    { key: "amount", label: "Amount", type: "money" },
    { key: "probability", label: "Probability", type: "number" },
  ],
};

const node = (id: string, kind: string, fields: Record<string, unknown>, extra: Partial<RecordNodeLike> = {}): RecordNodeLike => ({
  id,
  kind,
  title: id,
  data: { fields },
  ...extra,
});
const eur = (amount: number) => ({ amount, currency: "EUR" });

function kpi(key: string, current: number | null, series: (number | null)[] = []): KpiValue {
  const def = KPI_DEFINITIONS.saas.find((k) => k.key === key) ?? { key, label: key, unit: "money" as const, higher_is_better: true, definition: "" };
  return {
    ...def,
    current,
    current_label: def.label,
    current_definition: def.definition,
    current_is_partial: false,
    previous: null,
    delta: null,
    delta_pct: null,
    comparison: { basis: "full_period", through_day: null, previous_period: "2026-10", year_ago_period: "2025-11" },
    year_ago: null,
    yoy_delta_pct: null,
    series: series.map((value, i) => ({ period: `2026-${String(i + 1).padStart(2, "0")}`, value })),
  };
}
const summary = (kpis: KpiValue[], extra: Partial<MetricsSummary> = {}): MetricsSummary => ({
  business_model: "b2b",
  kpi_set: "saas",
  period: "month",
  current_period: "2026-11",
  currency: "EUR",
  kpis,
  comparison_note: null,
  expenses_by_category: {},
  computed_at: null,
  notes: [],
  ...extra,
});

describe("top KPIs", () => {
  it("only names KPIs the contract defines for the model's set", () => {
    const saas = new Set(KPI_DEFINITIONS.saas.map((k) => k.key));
    const market = new Set(KPI_DEFINITIONS.marketplace.map((k) => k.key));
    for (const model of ["b2b", "b2c"] as const) {
      for (const top of TOP_KPIS[model]) for (const key of [top.key, ...top.secondary]) expect(saas.has(key), key).toBe(true);
    }
    for (const top of TOP_KPIS.marketplace) for (const key of [top.key, ...top.secondary]) expect(market.has(key), key).toBe(true);
  });

  it("calls a summary of nulls and zeros 'no data yet'", () => {
    expect(summaryHasData(null)).toBe(false);
    expect(summaryHasData(summary([kpi("mrr", null, [null, 0])]))).toBe(false);
    expect(summaryHasData(summary([kpi("mrr", 100, [0, 100])]))).toBe(true);
  });

  it("hangs contraction and churn below the axis", () => {
    const rows = mrrMovementSeries(summary([kpi("mrr", 100, [90, 100]), kpi("new_mrr", 20, [0, 20]), kpi("churned_mrr", 10, [0, 10])]));
    expect(rows[1]).toMatchObject({ mrr: 100, new_mrr: 20, churned_mrr: -10, contraction_mrr: -0 });
  });

  it("orders expenses largest first and drops zeros", () => {
    expect(expensesByCategory(summary([], { expenses_by_category: { ai: 50, infra: 200, tools: 0 } }))).toEqual([
      { category: "infra", amount: 200 },
      { category: "ai", amount: 50 },
    ]);
  });
});

describe("roles", () => {
  it("finds a type by what templates call it", () => {
    expect(findRole([{ key: "client" }, { key: "deal" }], "customer")?.key).toBe("client");
    expect(findRole([{ key: "opportunity" }], "deal")?.key).toBe("opportunity");
    expect(findRole([{ key: "zone" }], "customer")).toBeNull();
  });
});

describe("SaaS action lists", () => {
  const accounts = [
    node("a1", "account", { mrr: eur(100), health: "at_risk", renewal_date: "2026-11-20" }),
    node("a2", "account", { mrr: eur(900), health: "at_risk", requests: ["r1"] }),
    node("a3", "account", { mrr: eur(50), health: "good", renewal_date: "2026-11-02" }),
    node("a4", "account", { mrr: eur(10) }, { status: "at_risk" }),
  ];

  it("lists accounts at risk, costliest first", () => {
    expect(accountsAtRisk(accounts, account, money)?.map((r) => r.id)).toEqual(["a2", "a1", "a4"]);
    expect(accountsAtRisk(accounts, null, money)).toBeNull();
  });

  it("lists this month's renewals in date order, flagging the past ones", () => {
    const rows = renewalsThisMonth(accounts, account, new Date("2026-11-12T00:00:00Z"))!;
    expect(rows.map((r) => r.id)).toEqual(["a3", "a1"]);
    expect(rows[0]!.tone).toBe("warning");
    expect(renewalsThisMonth(accounts, { fields: [] }, new Date())).toBeNull();
  });

  it("ranks requests by the MRR asking, from either side of the relation", () => {
    const requests = [
      node("r1", "request", { stage: "open", accounts: ["a1"] }),
      node("r2", "request", { stage: "open", accounts: ["a3"] }),
      node("r3", "request", { stage: "done", accounts: ["a2"] }),
      node("r4", "request", { stage: "open" }),
    ];
    const rows = topRequestsByMrr(requests, request, accounts, account, money)!;
    expect(rows.map((r) => [r.id, r.weight])).toEqual([["r1", 1000], ["r2", 50]]);
  });

  it("counts the customers an open bug reaches through any record", () => {
    const bugs = [node("b1", "bug", {}, { status: "todo" }), node("b2", "bug", {}, { status: "done" })];
    const records = [
      node("r1", "request", { accounts: ["a1", "a2"], bug: "b1" }),
      node("r2", "request", { accounts: ["a2"], bug: "b2" }),
    ];
    const rows = bugsAffectingCustomers(bugs, records, [account, request], "account")!;
    expect(rows).toEqual([expect.objectContaining({ id: "b1", chip: "2 affected" })]);
    expect(bugsAffectingCustomers(bugs, records, [account, request], null)).toBeNull();
  });

  it("weights the open pipeline by probability, or by stage when there is none", () => {
    const deals = [
      node("d1", "deal", { stage: "trial", amount: eur(1000), probability: 50 }),
      node("d2", "deal", { stage: "proposal", amount: eur(2000) }),
      node("d3", "deal", { stage: "won", amount: eur(9999) }),
    ];
    const pipeline = weightedPipeline(deals, deal, money)!;
    expect(pipeline.total).toBe(3000);
    // proposal is the 3rd of 3 open stages: 3 / 4.
    expect(pipeline.weighted).toBe(500 + 1500);
    expect(pipeline.stages.map((s) => s.stage)).toEqual(["lead", "trial", "proposal"]);
    expect(pipeline.deals[0]!.id).toBe("d2");
  });
});

describe("marketplace action lists", () => {
  const zone: RecordTypeDefinition = { key: "zone", label: "Zone", storage: "node", fields: [{ key: "demand", label: "Demand", type: "number" }] };
  const supplier: RecordTypeDefinition = { key: "supplier", label: "Supplier", storage: "node", fields: [{ key: "zone", label: "Zone", type: "relation", target: "zone" }] };

  it("ranks zones by demand per supplier, empty ones first", () => {
    const zones = [node("z1", "zone", { demand: 10 }), node("z2", "zone", { demand: 30 }), node("z3", "zone", { demand: 0 })];
    const suppliers = [node("s1", "supplier", { zone: "z2" }), node("s2", "supplier", { zone: "z2" })];
    const rows = underSuppliedZones(zones, zone, suppliers, supplier)!;
    expect(rows.map((r) => r.id)).toEqual(["z1", "z2"]);
    expect(rows[0]).toMatchObject({ chip: "10 demand · 0 supply", tone: "danger" });
    expect(underSuppliedZones(zones, { key: "zone", fields: [] }, [], null)).toBeNull();
  });

  it("lists open incidents and requests by segment", () => {
    const incident: RecordTypeDefinition = {
      key: "incident",
      label: "Incident",
      storage: "node",
      stage_field: "stage",
      fields: [{ key: "stage", label: "Stage", type: "select", options: ["open", "resolved"] }, { key: "severity", label: "Severity", type: "select", options: ["low", "high"] }],
    };
    const rows = openIncidents([node("i1", "incident", { stage: "resolved" }), node("i2", "incident", { stage: "open", severity: "high" })], incident)!;
    expect(rows).toEqual([expect.objectContaining({ id: "i2", tone: "danger" })]);
    expect(requestsBySegment([node("r1", "request", { segment: "buyers" }), node("r2", "request", { segment: "buyers" }), node("r3", "request", {})], request)).toEqual([
      { segment: "buyers", count: 2 },
      { segment: "Unspecified", count: 1 },
    ]);
  });
});

describe("buildingNow", () => {
  it("lists work and knowledge, not records, with this week's counts", () => {
    const now = new Date("2026-11-12T00:00:00Z");
    const nodes = [
      { id: "1", kind: "task", status: "done", updated_at: "2026-11-11T00:00:00Z" },
      { id: "2", kind: "account", status: null, updated_at: "2026-11-11T12:00:00Z" },
      { id: "3", kind: "decision", status: null, updated_at: "2026-10-01T00:00:00Z" },
    ];
    const model = buildingNow(nodes, now);
    expect(model.items.map((n) => n.id)).toEqual(["1", "3"]);
    expect(model).toMatchObject({ changedThisWeek: 1, shippedThisWeek: 1 });
  });
});
