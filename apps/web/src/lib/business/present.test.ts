import { describe, expect, it } from "vitest";
import type { KpiValue } from "@bcontext-dev/contract/business/metrics";
import { bucketLabel, formatKpi, heatColor, kpiCard, sparklinePath } from "./present";

const kpi = (over: Partial<KpiValue>): KpiValue => ({
  key: "mrr",
  label: "MRR",
  unit: "money",
  higher_is_better: true,
  definition: "",
  current: 1100,
  previous: 1000,
  delta: 100,
  delta_pct: 0.1,
  year_ago: 500,
  yoy_delta_pct: 1.2,
  series: [{ period: "2026-01", value: 1000 }, { period: "2026-02", value: 1100 }],
  ...over,
});

describe("kpiCard", () => {
  it("prints value and delta against the previous month", () => {
    const card = kpiCard(kpi({}), "previous", "EUR", "en-GB");
    expect(card).toMatchObject({ value: "€1,100", delta: "+10%", tone: "good", against: "previous month" });
  });

  it("compares with a year ago when asked (seasonality)", () => {
    expect(kpiCard(kpi({}), "year_ago", "EUR", "en-GB")).toMatchObject({ delta: "+120%", against: "same month last year" });
  });

  it("moves percents in points and reads falling churn as good", () => {
    const churn = kpi({ key: "logo_churn_rate", unit: "percent", higher_is_better: false, current: 0.03, previous: 0.04 });
    expect(kpiCard(churn, "previous", "EUR", "en-GB")).toMatchObject({ value: "3%", delta: "-1 pts", tone: "good" });
  });

  it("never invents a value or a delta", () => {
    expect(kpiCard(kpi({ current: null }), "previous", "EUR")).toMatchObject({ value: "—", delta: null, tone: "flat" });
    expect(kpiCard(kpi({ previous: 0 }), "previous", "EUR").delta).toBeNull();
    expect(formatKpi(2.5, "months", "EUR", "en-GB")).toBe("2.5 mo");
  });
});

describe("sparklinePath", () => {
  it("draws a line across the box and breaks on nulls", () => {
    expect(sparklinePath([0, 10], 100, 20, 0)).toBe("M0 20L100 0");
    expect(sparklinePath([0, null, 10], 100, 20, 0)).toBe("M0 20M100 0");
    expect(sparklinePath([5, 5], 100, 20, 0)).toBe("M0 10L100 10");
    expect(sparklinePath([null], 100, 20)).toBe("");
  });
});

describe("heatmap + labels", () => {
  it("keeps empty cells transparent and scales the mix", () => {
    expect(heatColor(null, "good")).toBe("transparent");
    expect(heatColor(1, "bad")).toBe("color-mix(in oklab, var(--warn) 80%, var(--paper))");
  });

  it("labels buckets", () => {
    expect(bucketLabel("2026-02-09", "week", "en-GB")).toBe("9 Feb");
    expect(bucketLabel("alps", null)).toBe("alps");
  });
});
