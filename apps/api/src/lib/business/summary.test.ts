/**
 * The summary the dashboard reads, from rollup rows to KPIs. Built on the
 * real rollup so the two cannot disagree about what a row means.
 */
import { describe, expect, it } from "vitest";
import type { RollupEvent } from "./events";
import { computeRollups } from "./rollup";
import { currentKpiWording, isPeriodOpen } from "@bcontext-dev/contract/business/metrics";
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
    dayRows: rows.filter((r) => r.grain === "day"),
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

  it("burn from expenses and revenue; no runway without a closed month that burned", () => {
    expect(kpi(summary, "burn").current).toBeGreaterThan(0);
    // September (the only closed month) earned 200 and spent nothing.
    expect(kpi(summary, "runway_months").current).toBeNull();
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
    dayRows: rows.filter((r) => r.grain === "day"),
    computedAt: null,
    now: new Date("2026-12-12T10:00:00Z"),
  });

  it("compares with the same days of last month and of the same month last year", () => {
    const gmv = kpi(summary, "gmv");
    expect(gmv.current).toBe(0);
    // Nov 1–12 (x3 canceled) and Dec 2025 1–12: the 12th is the cut.
    expect(gmv.previous).toBe(1500);
    expect(gmv.year_ago).toBe(1000);
    expect(gmv.yoy_delta_pct).toBe(-1);
    expect(gmv.comparison).toEqual({ basis: "same_days", through_day: 12, previous_period: "2026-11", year_ago_period: "2025-12" });
  });

  it("rates: take rate, cancellations, repeat buyers", () => {
    const november = (key: string) => kpi(summary, key).series.find((point) => point.period === "2026-11")!.value;
    expect(november("take_rate")).toBeCloseTo(210 / 1500);
    expect(november("cancellation_rate")).toBe(0.5);
    expect(november("repeat_buyer_rate")).toBe(1);
    // Over Nov 1–12 as well, the window the running December is held to.
    expect(kpi(summary, "take_rate").previous).toBeCloseTo(210 / 1500);
    // December has no bookings: a rate over nothing is null, not 0.
    expect(kpi(summary, "take_rate").current).toBeNull();
  });

  it("says the workspace's own words for its sides, and keeps the keys", () => {
    expect(kpi(summary, "active_suppliers").label).toBe("Active suppliers");
    const renamed = buildMetricsSummary({
      settings: { business_model: "marketplace", currency: "EUR" },
      monthRows: rows.filter((r) => r.grain === "month"),
      computedAt: null,
      now: new Date("2026-12-12T10:00:00Z"),
      names: { supplier: { one: "Instructor", many: "Instructors" }, buyer: { one: "Client", many: "Clients" } },
    });
    expect(kpi(renamed, "active_suppliers")).toMatchObject({ label: "Active instructors", previous: kpi(summary, "active_suppliers").previous });
    expect(kpi(renamed, "active_suppliers").definition).toMatch(/^Distinct instructors /);
    expect(kpi(renamed, "repeat_buyer_rate").label).toBe("Repeat clients");
    expect(kpi(renamed, "new_buyers").label).toBe("New clients");
  });
});

describe("a month still running", () => {
  // v0.4.2: mid-month, "Net" was a fortnight of prorated revenue minus the
  // month's whole payroll and read like a loss. Its card now says so.
  const events = [
    ev("subscription.started", "2026-10-01", { subject_id: "a", amount: 3000 }),
    ev("expense.recorded", "2026-11-01", { amount: 2500, properties: { category: "payroll" } }),
  ];
  const { rows } = computeRollups(events, { currency: "EUR", today: "2026-11-12", businessModel: "b2b" });
  const summary = buildMetricsSummary({
    settings: { business_model: "b2b", currency: "EUR" },
    monthRows: rows.filter((r) => r.grain === "month"),
    computedAt: null,
    now: new Date("2026-11-12T10:00:00Z"),
  });

  it("labels the flows of the current month as month to date, and keeps their keys", () => {
    const net = kpi(summary, "net");
    expect(net.current!).toBeLessThan(0);
    expect(net).toMatchObject({ key: "net", label: "Net", current_label: "Net (month to date)", current_is_partial: true });
    expect(net.current_definition).toMatch(/^Revenue minus expenses for the month\. This month is not over/);
    expect(kpi(summary, "expenses").current_label).toBe("Expenses (month to date)");
    expect(kpi(summary, "burn").current_label).toBe("Burn (month to date)");
  });

  it("leaves stocks alone: MRR is what it is today; rates over the month's flows are to date", () => {
    expect(kpi(summary, "mrr")).toMatchObject({ current_label: "MRR", current_is_partial: false });
    expect(kpi(summary, "arpa").current_label).toBe("ARPA");
    expect(kpi(summary, "nrr").current_label).toBe("NRR (month to date)");
  });

  it("says month to date for the marketplace's GMV, take and bookings, with renamed sides kept", () => {
    const market = buildMetricsSummary({
      settings: { business_model: "marketplace", currency: "EUR" },
      monthRows: [],
      computedAt: null,
      now: new Date("2026-11-12T10:00:00Z"),
      names: { supplier: { one: "Instructor", many: "Instructors" } },
    });
    expect(["gmv", "take", "bookings", "net"].map((key) => kpi(market, key).current_label)).toEqual([
      "GMV (month to date)", "Take (month to date)", "Bookings (month to date)", "Net (month to date)",
    ]);
    expect(kpi(market, "active_suppliers").current_label).toBe("Active instructors (month to date)");
  });

  it("calls a closed month plain Net", () => {
    expect(isPeriodOpen("2026-10", new Date("2026-11-01T00:00:00Z"))).toBe(false);
    expect(isPeriodOpen("2026-11", new Date("2026-11-30T23:59:59Z"))).toBe(true);
    const net = { label: "Net", definition: "Revenue minus expenses for the month.", to_date: "Month to date." };
    expect(currentKpiWording(net, false)).toEqual({ label: "Net", definition: net.definition, partial: false });
    expect(currentKpiWording(net, true).label).toBe("Net (month to date)");
  });
});

describe("product workspaces", () => {
  it("have no KPI set and say how to get one", () => {
    const summary = buildMetricsSummary({ settings: { business_model: "product", currency: "EUR" }, monthRows: [], computedAt: null });
    expect(summary.kpis).toEqual([]);
    expect(summary.notes[0]).toContain("business_model");
  });
});

/** The summary over the real rollup, as the route builds it (day rows included). */
function summarize(model: "b2b" | "marketplace", events: RollupEvent[], today: string) {
  const { rows } = computeRollups(events, { currency: "EUR", today, businessModel: model });
  return buildMetricsSummary({
    settings: { business_model: model, currency: "EUR" },
    monthRows: rows.filter((r) => r.grain === "month"),
    dayRows: rows.filter((r) => r.grain === "day"),
    computedAt: null,
    now: new Date(`${today}T18:00:00Z`),
  });
}

describe("runway (v0.4.3: never from the running month's burn)", () => {
  // One customer at 1000/month from Aug 1, so a closed month earns exactly
  // 1000. Burn: Aug 4000−1000 = 3000, Sep 3000, Oct 7000−1000 = 6000.
  // November has booked 9000 by the 12th against 400 earned (12/30 of 1000).
  const summary = summarize("b2b", [
    ev("subscription.started", "2026-08-01", { subject_id: "a", amount: 1000 }),
    ev("expense.recorded", "2026-08-01", { amount: 4000 }),
    ev("expense.recorded", "2026-09-01", { amount: 4000 }),
    ev("expense.recorded", "2026-10-01", { amount: 7000 }),
    ev("cash.balance", "2026-10-01", { amount: 33000 }),
    ev("expense.recorded", "2026-11-01", { amount: 9000 }),
    ev("cash.balance", "2026-11-01", { amount: 30000 }),
  ], "2026-11-12");
  const runway = kpi(summary, "runway_months");

  it("divides the latest cash by the mean burn of the last three closed months", () => {
    // 30000 ÷ ((3000 + 3000 + 6000) ÷ 3) = 30000 ÷ 4000 — not 30000 ÷ 8600.
    expect(kpi(summary, "burn").current).toBeCloseTo(8600);
    expect(runway.current).toBeCloseTo(7.5);
  });

  it("includes a closed month's own burn in its runway, end of month against end of month", () => {
    // October is closed: 33000 ÷ ((6000 + 3000 + 3000) ÷ 3) = 8.25.
    expect(runway.previous).toBeCloseTo(8.25);
    expect(runway.comparison.basis).toBe("full_period");
    // September had no cash.balance yet: no runway, not 0.
    expect(runway.series.find((p) => p.period === "2026-09")!.value).toBeNull();
  });

  it("averages what a young company has", () => {
    const young = summarize("b2b", [
      ev("expense.recorded", "2026-10-01", { amount: 5000 }),
      ev("cash.balance", "2026-11-01", { amount: 20000 }),
      ev("expense.recorded", "2026-11-02", { amount: 1000 }),
    ], "2026-11-12");
    // Only October is closed: 20000 ÷ 5000.
    expect(kpi(young, "runway_months").current).toBeCloseTo(4);
  });
});

describe("like-for-like comparisons while the month runs (v0.4.3)", () => {
  const summary = summarize("b2b", [
    ev("expense.recorded", "2025-11-05", { amount: 800 }),
    ev("expense.recorded", "2025-11-25", { amount: 300 }),
    ev("subscription.started", "2026-10-03", { subject_id: "a", amount: 100 }),
    ev("expense.recorded", "2026-10-01", { amount: 1000 }),
    ev("subscription.started", "2026-10-15", { subject_id: "b", amount: 200 }),
    ev("expense.recorded", "2026-10-20", { amount: 500 }),
    ev("expense.recorded", "2026-11-01", { amount: 1000 }),
    ev("subscription.started", "2026-11-04", { subject_id: "c", amount: 50 }),
  ], "2026-11-12");

  it("compares a flow's month to date with the same days of last month and of last year", () => {
    const expenses = kpi(summary, "expenses");
    // Nov 1–12: 1000. Oct 1–12: 1000 (the 500 of Oct 20 is after the cut).
    // Nov 2025 1–12: 800 (the 300 of Nov 25 too).
    expect(expenses).toMatchObject({ current: 1000, previous: 1000, delta: 0, delta_pct: 0, year_ago: 800, yoy_delta_pct: 0.25 });
    expect(expenses.comparison).toEqual({ basis: "same_days", through_day: 12, previous_period: "2026-10", year_ago_period: "2025-11" });
  });

  it("counts new customers over the same days: one this month, one by Oct 12 — not −50%", () => {
    expect(kpi(summary, "new_customers")).toMatchObject({ current: 1, previous: 1, delta_pct: 0 });
    // A year ago nobody was a customer: 0 new, and no percentage over 0.
    expect(kpi(summary, "new_customers")).toMatchObject({ year_ago: 0, yoy_delta_pct: null });
  });

  it("keeps end-of-month comparisons for stocks", () => {
    expect(kpi(summary, "mrr")).toMatchObject({ current: 350, previous: 300, delta: 50 });
    expect(kpi(summary, "mrr").comparison.basis).toBe("full_period");
    expect(kpi(summary, "active_customers")).toMatchObject({ current: 3, previous: 2 });
  });

  it("cuts MRR growth at the same day too", () => {
    // Nov: (350 − 300) ÷ 300. Oct 1–12 started from 0 MRR: no growth rate.
    expect(kpi(summary, "mrr_growth").current).toBeCloseTo(50 / 300);
    expect(kpi(summary, "mrr_growth").previous).toBeNull();
  });

  it("says which comparison it used", () => {
    expect(summary.comparison_note).toBe(
      "Month-to-date KPIs compare Nov 1–12 vs Oct 1–12 (year over year: Nov 2026 1–12 vs Nov 2025 1–12). " +
        "MRR, Active customers, ARPA, Runway compare end of month with end of month.",
    );
    expect(summary.notes).toContain(summary.comparison_note);
  });

  it("caps the window at a shorter month's end", () => {
    const march = summarize("b2b", [
      ev("expense.recorded", "2026-02-27", { amount: 100 }),
      ev("expense.recorded", "2026-03-30", { amount: 40 }),
    ], "2026-03-30");
    // Mar 1–30 against all of February (28 days).
    expect(kpi(march, "expenses")).toMatchObject({ current: 40, previous: 100 });
    expect(kpi(march, "expenses").comparison.through_day).toBe(30);
  });

  it("shows no change for distinct counts the day rows cannot cut", () => {
    const booking = (at: string, id: string, buyer: string) =>
      ev("booking.created", at, { subject_id: buyer, amount: 100, properties: { booking_id: id, supplier_id: "s1", fee: 10 } });
    const market = summarize("marketplace", [
      booking("2026-10-02", "b1", "ana"),
      booking("2026-10-03", "b2", "ana"),
      booking("2026-10-25", "b3", "ben"),
      booking("2026-11-02", "b4", "ana"),
    ], "2026-11-12");
    // Bookings Nov 1–12: 1 against Oct 1–12: 2; GMV 100 against 200.
    expect(kpi(market, "bookings")).toMatchObject({ current: 1, previous: 2, delta_pct: -0.5 });
    expect(kpi(market, "gmv")).toMatchObject({ current: 100, previous: 200 });
    // ana's first booking ever was on Oct 2: Oct 1–12 has one new buyer.
    expect(kpi(market, "new_buyers")).toMatchObject({ current: 0, previous: 1 });
    expect(kpi(market, "active_buyers")).toMatchObject({ current: 1, previous: null, delta: null });
    expect(kpi(market, "active_buyers").comparison.basis).toBe("none");
    expect(market.comparison_note).toMatch(/Active suppliers, Active buyers, Repeat buyers: no like-for-like comparison until the month closes\.$/);
  });
});
