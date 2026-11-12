import { describe, expect, it } from "vitest";
import { BusinessEventInputSchema, isCanonicalEventType } from "./events.js";
import { KPI_DEFINITIONS, kpiSetFor } from "./metrics.js";

const at = "2026-11-01T10:00:00Z";

function issues(input: unknown): string {
  const result = BusinessEventInputSchema.safeParse(input);
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n");
}

describe("business event vocabulary", () => {
  it("accepts the canonical B2B subscription event", () => {
    expect(issues({
      type: "subscription.started",
      occurred_at: at,
      idempotency_key: "sub_1:started",
      subject_type: "account",
      subject_id: "acc_42",
      amount: 490,
      currency: "EUR",
      properties: { subscription_id: "sub_1", plan: "pro" },
    })).toBe("");
  });

  it("accepts the canonical marketplace booking event", () => {
    expect(issues({
      type: "booking.created",
      occurred_at: at,
      idempotency_key: "bk_9:created",
      subject_id: "cli_7",
      amount: 180,
      currency: "EUR",
      properties: { booking_id: "bk_9", supplier_id: "ins_3", fee: 27 },
    })).toBe("");
  });

  it("checks canonical types strictly, naming what is missing", () => {
    expect(issues({ type: "subscription.started", occurred_at: at, idempotency_key: "k" })).toMatch(/needs subject_id[\s\S]*needs an amount/);
    expect(issues({ type: "booking.created", occurred_at: at, idempotency_key: "k", subject_id: "c", amount: 1, currency: "EUR" }))
      .toMatch(/properties.booking_id[\s\S]*properties.supplier_id/);
    expect(issues({ type: "expense.recorded", occurred_at: at, idempotency_key: "k", amount: 10, currency: "EUR", properties: { category: "food" } }))
      .toContain("infra | ai | tools | payroll | marketing | other");
    expect(issues({ type: "expense.recorded", occurred_at: at, idempotency_key: "k", amount: -1, currency: "EUR", properties: { category: "ai" } }))
      .toContain("≥ 0");
    expect(issues({ type: "cash.balance", occurred_at: at, idempotency_key: "k", amount: -50, currency: "EUR" })).toBe("");
  });

  it("an amount needs a currency", () => {
    expect(issues({ type: "custom.thing", occurred_at: at, idempotency_key: "k", amount: 5 })).toContain("currency");
  });

  it("stores unknown types of the right shape and refuses malformed ones", () => {
    expect(issues({ type: "feature.used", occurred_at: at, idempotency_key: "k", properties: { feature: "x" } })).toBe("");
    expect(isCanonicalEventType("feature.used")).toBe(false);
    expect(issues({ type: "Feature Used", occurred_at: at, idempotency_key: "k" })).toContain("dotted lowercase");
    expect(issues({ type: "feature", occurred_at: at, idempotency_key: "k" })).toContain("dotted lowercase");
  });

  it("refuses an unknown top-level key (PII sneaking in as `email`)", () => {
    expect(issues({ type: "feature.used", occurred_at: at, idempotency_key: "k", email: "a@b.c" })).not.toBe("");
  });
});

describe("KPI sets", () => {
  it("maps business models to KPI sets", () => {
    expect(kpiSetFor("b2b")).toBe("saas");
    expect(kpiSetFor("b2c")).toBe("saas");
    expect(kpiSetFor("marketplace")).toBe("marketplace");
    expect(kpiSetFor("product")).toBeNull();
  });

  it("has unique keys and a definition for every KPI", () => {
    for (const set of Object.values(KPI_DEFINITIONS)) {
      const keys = set.map((kpi) => kpi.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const kpi of set) expect(kpi.definition.length).toBeGreaterThan(10);
    }
  });
});
