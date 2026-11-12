/**
 * The summary the dashboard reads, from rollup rows to KPIs. Built on the
 * real rollup so the two cannot disagree about what a row means.
 */
import { describe, expect, it } from "vitest";
import type { RollupEvent } from "./events";
import { computeRollups } from "./rollup";
import { buildMetricsSummary } from "./summary";

function ev(type: string, at: string, rest: Partial<RollupEvent> = {}): RollupEvent {
  return { type, occurred_at: `${at}T12:00:00.000Z`, subject_id: null, amount: null, currency: "EUR", properties: {}, ...rest };
}

const kpi = (summary: ReturnType<typeof buildMetricsSummary>, key: string) => summary.kpis.find((k) => k.key === key)!;

describe("SaaS summary", () => {
  const events = [
    ev("subscription.started", "2026-09-01", { subject_id: "a", amount: 100 }),
    ev("subscription.started", "2026-09-01", { subject_id: "b", amount: 100 }),
    ev("subscription.changed", "2026-10-10", { subject_id: "a", amount: 150 }),
    ev("subscription.canceled", "2026-10-20", { subject_id: "b" }),
    ev("subscription.started", "2026-10-21", { subject_id: "c", amount: 60 }),
    ev("expense.recorded", "2026-10-01", { amount: 1000, properties: { category: "payroll" } }),
    ev("cash.balance", "2026-10-31", { amount: 9000 }),
  ];
  const { rows } = computeRollups(events, { currency: "EUR", today: "2026-10-31", businessModel: "b2b" });
  const summary = buildMetricsSummary({
    settings: { business_model: "b2b", currency: "EUR" },
    monthRows: rows.filter((r) => r.grain === "month"),
    computedAt: "2026-10-31T00:00:00Z",
    now: new Date("2026-10-31T18:00:00Z"),
  });

  it("is the SaaS set for a b2b workspace, current month first", () => {
    expect(summary.kpi_set).toBe("saas");
    expect(summary.current_period).toBe("2026-10");
    expect(kpi(summary, "mrr").current).toBe(210);
    expect(kpi(summary, "mrr").previous).toBe(200);
    expect(kpi(summary, "mrr").delta).toBe(10);
    expect(kpi(summary, "mrr_growth").current).toBeCloseTo(0.05);
  });

  it("computes churn rates, NRR and ARPA against the month's start", () => {
    // Start: 200 MRR, 2 customers. b churned (100), a expanded (+50), c is new (60).
    expect(kpi(summary, "logo_churn_rate").current).toBeCloseTo(0.5);
    expect(kpi(summary, "revenue_churn_rate").current).toBeCloseTo(0.5);
    expect(kpi(summary, "nrr").current).toBeCloseTo((200 + 50 - 100) / 200);
    expect(kpi(summary, "net_new_mrr").current).toBe(10);
    expect(kpi(summary, "arpa").current).toBe(105);
  });

  it("burn and runway from expenses, revenue and the latest cash", () => {
    const burn = kpi(summary, "burn").current!;
    expect(burn).toBeGreaterThan(0);
    expect(kpi(summary, "runway_months").current).toBeCloseTo(9000 / burn);
    expect(summary.expenses_by_category).toEqual({ payroll: 1000 });
  });

  it("has a 12-month series, null before the first event — never 0", () => {
    const series = kpi(summary, "mrr").series;
    expect(series).toHaveLength(12);
    expect(series[11]).toEqual({ period: "2026-10", value: 210 });
    expect(series[0]).toEqual({ period: "2025-11", value: null });
    // September is the first month: start MRR was 0, so growth is undefined.
    expect(kpi(summary, "mrr_growth").previous).toBeNull();
    expect(kpi(summary, "mrr").year_ago).toBeNull();
  });
});

describe("marketplace summary", () => {
  const booking = (at: string, id: string, buyer: string, gross: number, fee: number) =>
    ev("booking.created", at, { subject_id: buyer, amount: gross, properties: { booking_id: id, supplier_id: "ins", fee } });
  const events = [
    booking("2025-12-10", "x1", "ana", 1000, 150),
    booking("2026-11-03", "x2", "ana", 1500, 210),
    booking("2026-11-04", "x3", "ben", 500, 70),
    ev("booking.canceled", "2026-11-05", { properties: { booking_id: "x3" } }),
  ];
  const { rows } = computeRollups(events, { currency: "EUR", today: "2026-12-12", businessModel: "marketplace" });
  const summary = buildMetricsSummary({
    settings: { business_model: "marketplace", currency: "EUR" },
    monthRows: rows.filter((r) => r.grain === "month"),
    computedAt: null,
    now: new Date("2026-12-12T10:00:00Z"),
  });

  it("compares with the same month last year", () => {
    const gmv = kpi(summary, "gmv");
    expect(gmv.current).toBe(0);
    expect(gmv.previous).toBe(1500);
    expect(gmv.year_ago).toBe(1000);
    expect(gmv.yoy_delta_pct).toBe(-1);
  });

  it("rates: take rate, cancellations, repeat buyers", () => {
    const november = (key: string) => kpi(summary, key).previous;
    expect(november("take_rate")).toBeCloseTo(210 / 1500);
    expect(november("cancellation_rate")).toBe(0.5);
    expect(november("repeat_buyer_rate")).toBe(1);
    // December has no bookings: a rate over nothing is null, not 0.
    expect(kpi(summary, "take_rate").current).toBeNull();
  });
});

describe("product workspaces", () => {
  it("have no KPI set and say how to get one", () => {
    const summary = buildMetricsSummary({ settings: { business_model: "product", currency: "EUR" }, monthRows: [], computedAt: null });
    expect(summary.kpis).toEqual([]);
    expect(summary.notes[0]).toContain("business_model");
  });
});
