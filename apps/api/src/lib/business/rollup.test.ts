/**
 * The rollup's definitions, pinned on small histories whose answers can be
 * worked out by hand. The identities matter more than any one number: MRR
 * bridges exactly from one period to the next, and a booking canceled later
 * leaves the GMV of the month it was created in.
 */
import { describe, expect, it } from "vitest";
import type { MetricRollupRow } from "@bcontext-dev/contract/business/metrics";
import type { RollupEvent } from "./events";
import { computeRollups } from "./rollup";

function ev(type: string, at: string, rest: Partial<RollupEvent> = {}): RollupEvent {
  return { type, occurred_at: `${at}T12:00:00.000Z`, subject_id: null, amount: null, currency: "EUR", properties: {}, ...rest };
}

function value(rows: MetricRollupRow[], grain: "day" | "month", period: string, metric: string, dimension = ""): number | undefined {
  return rows.find((r) => r.grain === grain && r.period_start === period && r.metric === metric && r.dimension === dimension)?.value;
}

describe("SaaS rollup", () => {
  const events: RollupEvent[] = [
    // January: two customers start.
    ev("subscription.started", "2026-01-05", { subject_id: "acme", amount: 100 }),
    ev("subscription.started", "2026-01-20", { subject_id: "globex", amount: 300 }),
    // February: acme expands, globex contracts, a third arrives and leaves.
    ev("subscription.changed", "2026-02-03", { subject_id: "acme", amount: 150 }),
    ev("subscription.changed", "2026-02-10", { subject_id: "globex", amount: 200 }),
    ev("subscription.started", "2026-02-12", { subject_id: "initech", amount: 50 }),
    ev("subscription.canceled", "2026-02-25", { subject_id: "initech" }),
    // March: globex churns; acme adds a second subscription.
    ev("subscription.canceled", "2026-03-02", { subject_id: "globex" }),
    ev("subscription.started", "2026-03-15", { subject_id: "acme", amount: 40, properties: { subscription_id: "acme-ai" } }),
  ];
  const { rows } = computeRollups(events, { currency: "EUR", today: "2026-03-31", businessModel: "b2b" });

  it("ends each month at the sum of live subscriptions", () => {
    expect(value(rows, "month", "2026-01-01", "mrr")).toBe(400);
    expect(value(rows, "month", "2026-02-01", "mrr")).toBe(350);
    expect(value(rows, "month", "2026-03-01", "mrr")).toBe(190);
    expect(value(rows, "month", "2026-03-01", "active_customers")).toBe(1);
  });

  it("classifies by each customer's MRR at the period's start and end", () => {
    // February: acme +50 expansion, globex −100 contraction; initech came and
    // went inside the month, so it is neither new nor churned.
    expect(value(rows, "month", "2026-02-01", "expansion_mrr")).toBe(50);
    expect(value(rows, "month", "2026-02-01", "contraction_mrr")).toBe(100);
    expect(value(rows, "month", "2026-02-01", "new_mrr")).toBe(0);
    expect(value(rows, "month", "2026-02-01", "churned_customers")).toBe(0);
    // March: globex churns 200, acme's second subscription is expansion.
    expect(value(rows, "month", "2026-03-01", "churned_mrr")).toBe(200);
    expect(value(rows, "month", "2026-03-01", "churned_customers")).toBe(1);
    expect(value(rows, "month", "2026-03-01", "expansion_mrr")).toBe(40);
  });

  it("bridges exactly: end = start + new + expansion − contraction − churned", () => {
    let previous = 0;
    for (const month of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      const get = (m: string) => value(rows, "month", month, m) ?? 0;
      expect(get("mrr")).toBeCloseTo(previous + get("new_mrr") + get("expansion_mrr") - get("contraction_mrr") - get("churned_mrr"));
      previous = get("mrr");
    }
    // ...and per day, which is how a mid-month churn shows up on its date.
    expect(value(rows, "day", "2026-02-12", "new_mrr")).toBe(50);
    expect(value(rows, "day", "2026-02-25", "churned_mrr")).toBe(50);
  });

  it("recognises revenue as MRR prorated per day", () => {
    // January: 100/31 a day from the 5th, plus 300/31 a day from the 20th.
    const expected = (100 * 27 + 300 * 12) / 31;
    expect(value(rows, "month", "2026-01-01", "revenue")).toBeCloseTo(expected, 4);
  });
});

describe("marketplace rollup", () => {
  const booking = (at: string, id: string, buyer: string, supplier: string, gross: number, fee: number) =>
    ev("booking.created", at, { subject_id: buyer, amount: gross, properties: { booking_id: id, supplier_id: supplier, fee } });
  const events: RollupEvent[] = [
    booking("2026-01-10", "b1", "ana", "ins1", 200, 30),
    booking("2026-01-11", "b2", "ben", "ins2", 100, 15),
    booking("2026-01-12", "b3", "ana", "ins1", 300, 45),
    booking("2026-02-02", "b4", "ana", "ins2", 120, 18),
    booking("2026-02-03", "b5", "cai", "ins1", 80, 12),
    // b2 is canceled in February: it leaves January's GMV, not February's.
    ev("booking.canceled", "2026-02-05", { properties: { booking_id: "b2" } }),
    // b5 completes for a different final amount.
    ev("booking.completed", "2026-02-10", { amount: 90, properties: { booking_id: "b5", fee: 13.5 } }),
  ];
  const { rows } = computeRollups(events, { currency: "EUR", today: "2026-02-28", businessModel: "marketplace" });

  it("counts bookings by creation month with their final state", () => {
    expect(value(rows, "month", "2026-01-01", "bookings")).toBe(3);
    expect(value(rows, "month", "2026-01-01", "cancellations")).toBe(1);
    expect(value(rows, "month", "2026-01-01", "gmv")).toBe(500);
    expect(value(rows, "month", "2026-01-01", "take")).toBe(75);
    expect(value(rows, "month", "2026-02-01", "gmv")).toBe(210);
    expect(value(rows, "month", "2026-02-01", "take")).toBe(31.5);
    expect(value(rows, "month", "2026-02-01", "cancellations")).toBe(0);
  });

  it("counts distinct active, new and repeat buyers per month", () => {
    // January: ana only (ben's booking was canceled). February: ana repeats, cai is new.
    expect(value(rows, "month", "2026-01-01", "active_buyers")).toBe(1);
    expect(value(rows, "month", "2026-02-01", "active_buyers")).toBe(2);
    expect(value(rows, "month", "2026-02-01", "new_buyers")).toBe(1);
    expect(value(rows, "month", "2026-02-01", "repeat_buyers")).toBe(1);
    expect(value(rows, "month", "2026-02-01", "active_suppliers")).toBe(2);
  });

  it("uses take as revenue", () => {
    expect(value(rows, "month", "2026-02-01", "revenue")).toBe(31.5);
  });
});

describe("expenses, cash and currency", () => {
  const events: RollupEvent[] = [
    ev("expense.recorded", "2026-01-03", { amount: 1200, properties: { category: "infra" } }),
    ev("expense.recorded", "2026-01-04", { amount: 300, properties: { category: "ai" } }),
    ev("expense.recorded", "2026-01-05", { amount: 50, currency: "USD", properties: { category: "tools" } }),
    ev("cash.balance", "2026-01-31", { amount: 90_000 }),
    ev("subscription.started", "2026-01-01", { subject_id: "acme", amount: 310 }),
  ];
  const result = computeRollups(events, { currency: "EUR", today: "2026-02-15" });

  it("totals expenses and splits them by category", () => {
    expect(value(result.rows, "month", "2026-01-01", "expenses")).toBe(1500);
    expect(value(result.rows, "month", "2026-01-01", "expenses_by_category", "infra")).toBe(1200);
    expect(value(result.rows, "day", "2026-01-04", "expenses_by_category", "ai")).toBe(300);
  });

  it("leaves other currencies out and says how many", () => {
    expect(result.ignored).toBe(1);
    expect(value(result.rows, "month", "2026-01-01", "expenses_by_category", "tools")).toBeUndefined();
  });

  it("nets revenue against expenses and carries the latest cash forward", () => {
    // A full month at 310 MRR is 310 of revenue.
    expect(value(result.rows, "month", "2026-01-01", "net")).toBeCloseTo(310 - 1500, 4);
    expect(value(result.rows, "month", "2026-01-01", "cash_balance")).toBe(90_000);
    expect(value(result.rows, "month", "2026-02-01", "cash_balance")).toBe(90_000);
  });

  it("returns nothing for no events, and ignores the future", () => {
    expect(computeRollups([], { currency: "EUR" }).rows).toEqual([]);
    expect(computeRollups([ev("expense.recorded", "2099-01-01", { amount: 1, properties: { category: "ai" } })], { currency: "EUR", today: "2026-01-01" }).rows).toEqual([]);
  });
});
