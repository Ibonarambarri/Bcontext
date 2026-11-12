import { describe, expect, it } from "vitest";
import { bucketLabel, formatKpi, heatColor } from "./present";

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
