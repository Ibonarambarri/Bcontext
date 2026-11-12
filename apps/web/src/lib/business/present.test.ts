import { describe, expect, it } from "vitest";
import { bucketLabel, formatKpi, heatColor, heatmapLegend } from "./present";

describe("formatKpi", () => {
  it("never invents a value", () => {
    expect(formatKpi(null, "money", "EUR")).toBe("—");
    expect(formatKpi(2.5, "months", "EUR", "en-GB")).toBe("2.5 mo");
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

describe("heatmap legend", () => {
  it("draws the cells' own scale with its two ends, in words true in both themes", () => {
    const legend = heatmapLegend({ min: 0.5, max: 4 }, "bookings per supplier", "bad", (n) => String(n));
    expect(legend.low).toBe("0.5");
    expect(legend.high).toBe("4");
    expect(legend.gradient).toContain(heatColor(0, "bad"));
    expect(legend.gradient).toContain(heatColor(1, "bad"));
    expect(legend.caption).toContain("bookings per supplier");
    // The mix goes towards the page colour, which is dark in dark mode:
    // "darker" would be wrong there.
    expect(legend.caption).not.toMatch(/dark/i);
    expect(heatmapLegend(null, "x", "good", String)).toMatchObject({ low: null, high: null });
  });
});
