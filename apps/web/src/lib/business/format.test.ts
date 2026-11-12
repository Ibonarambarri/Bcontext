import { describe, expect, it } from "vitest";
import { comparisonTitle, deltaLabel, formatCount, formatKpiValue, formatMoney, formatMonths, formatPercent, periodLabel, yoyLabel } from "./format";
import { sparklinePath } from "./sparkline";

describe("business formatting", () => {
  it("prints unknown as a dash, never 0", () => {
    expect(formatMoney(null, "EUR")).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatKpiValue("months", null, "EUR")).toBe("—");
  });

  it("writes money in the reporting currency, compact when large", () => {
    expect(formatMoney(490, "EUR")).toBe("€490");
    expect(formatMoney(90, "EUR")).toBe("€90");
    expect(formatMoney(49.9, "EUR")).toBe("€49.90");
    expect(formatKpiValue("money", 150, "EUR")).toBe("€150");
    expect(formatMoney(12_500, "USD")).toBe("$12.5K");
    expect(formatMoney(5, "XXQ")).toContain("XXQ");
  });

  it("reads percents as fractions and months as months", () => {
    expect(formatPercent(0.052)).toBe("5.2%");
    expect(formatPercent(0.1)).toBe("10%");
    expect(formatMonths(7.25)).toBe("7.3 mo");
    expect(formatMonths(400)).toBe("10y+");
  });

  it("colours a change by whether up is good", () => {
    expect(deltaLabel({ unit: "money", delta: 100, delta_pct: 0.1, higher_is_better: true })).toEqual({ text: "+10.0%", tone: "good" });
    expect(deltaLabel({ unit: "money", delta: 100, delta_pct: 0.1, higher_is_better: false })?.tone).toBe("bad");
    // A rate changes in points, not in percent of itself.
    expect(deltaLabel({ unit: "percent", delta: -0.012, delta_pct: -0.3, higher_is_better: false })).toEqual({ text: "−1.2 pts", tone: "good" });
    expect(deltaLabel({ unit: "count", delta: null, delta_pct: null, higher_is_better: true })).toBeNull();
    expect(yoyLabel({ unit: "money", current: 125, year_ago: 100, yoy_delta_pct: 0.25, higher_is_better: true })?.text).toBe("+25.0% YoY");
  });

  it("changes a count in units, so two customers fewer is not −100%", () => {
    // v0.4.2's New customers card: 0 so far against 2 read "−100.0%".
    expect(deltaLabel({ unit: "count", delta: -2, delta_pct: -1, higher_is_better: true })).toEqual({ text: "−2", tone: "bad" });
    expect(deltaLabel({ unit: "count", delta: 0, delta_pct: null, higher_is_better: true })).toEqual({ text: "+0", tone: "flat" });
    expect(yoyLabel({ unit: "count", current: 9, year_ago: 6, yoy_delta_pct: 0.5, higher_is_better: true })).toEqual({ text: "+3 YoY", tone: "good" });
    expect(yoyLabel({ unit: "count", current: 9, year_ago: null, yoy_delta_pct: null, higher_is_better: true })).toBeNull();
  });

  it("says what a change compares", () => {
    const comparison = { basis: "same_days" as const, through_day: 12, previous_period: "2026-10", year_ago_period: "2025-11" };
    expect(comparisonTitle({ comparison })).toBe("Change: Nov 1–12 vs Oct 1–12");
    expect(comparisonTitle({ comparison }, "year_ago")).toBe("Change: Nov 2026 1–12 vs Nov 2025 1–12");
    expect(comparisonTitle({ comparison: { ...comparison, basis: "full_period", through_day: null } })).toBe("Change: end of Nov vs end of Oct");
    expect(comparisonTitle({})).toBeNull();
  });

  it("names a month", () => {
    expect(periodLabel("2026-11")).toBe("Nov");
    expect(periodLabel("2026-01", { year: true })).toBe("Jan 2026");
  });
});

describe("sparklinePath", () => {
  it("breaks the line at a gap and survives a flat series", () => {
    expect(sparklinePath([1, 2, null, 3, 4], 80, 32)).toMatch(/^M.*L.*M.*L/);
    expect(sparklinePath([5, 5, 5], 80, 32)).toBe("M0.0,16.0L40.0,16.0L80.0,16.0");
    expect(sparklinePath([null, 1], 80, 32)).toBeNull();
  });
});

describe("one money formatter", () => {
  it("is the contract's, so a KPI, a table cell and a timeline agree", async () => {
    const { formatMoney: shared } = await import("@bcontext-dev/contract/views/fields");
    for (const amount of [0, 9.99, 49.9, 90, 150, 999.5, 1240.5, 9_999]) {
      expect(formatMoney(amount, "EUR"), String(amount)).toBe(shared(amount, "EUR"));
    }
  });
});
