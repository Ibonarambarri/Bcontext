import { describe, expect, it } from "vitest";
import {
  AggregateSpecSchema,
  aggregateRows,
  aggregateSeries,
  bucketDate,
  businessLayoutIssues,
  heatmapGrid,
  layoutDatasetTypes,
  readEventKey,
  yearAgoBucket,
  type AggregateSpec,
} from "./business.js";

const bookingsByZoneWeek: AggregateSpec = AggregateSpecSchema.parse({
  source: { from: "events", types: ["booking.created"] },
  x: { key: "occurred_at", bucket: "week" },
  y: { key: "zone" },
  measures: [
    { as: "bookings", op: "count" },
    { as: "suppliers", op: "count_distinct", key: "supplier_id" },
  ],
});

const event = (occurred_at: string, zone: string, supplier_id: string, amount = 100) => ({
  type: "booking.created",
  occurred_at,
  amount,
  properties: { zone, supplier_id },
});

describe("bucketDate", () => {
  it("truncates to ISO weeks (Monday), months and days in UTC", () => {
    expect(bucketDate("2026-02-12T10:00:00Z", "week")).toBe("2026-02-09");
    expect(bucketDate("2026-02-09", "week")).toBe("2026-02-09");
    expect(bucketDate("2026-02-15T23:59:00Z", "week")).toBe("2026-02-09");
    expect(bucketDate("2026-02-12", "month")).toBe("2026-02-01");
    expect(bucketDate("2026-02-12T10:00:00+01:00", "day")).toBe("2026-02-12");
    expect(bucketDate("not a date", "day")).toBeNull();
  });

  it("aligns a year ago on weekdays for weeks and on months for months", () => {
    expect(yearAgoBucket("2026-02-09", "week")).toBe("2025-02-10");
    expect(new Date("2025-02-10T00:00:00Z").getUTCDay()).toBe(1);
    expect(yearAgoBucket("2026-02-01", "month")).toBe("2025-02-01");
  });
});

describe("aggregateRows", () => {
  it("groups events by bucketed date and a property, counting distinct suppliers", () => {
    const result = aggregateRows([
      event("2026-02-09T09:00:00Z", "alps", "s1"),
      event("2026-02-10T09:00:00Z", "alps", "s1"),
      event("2026-02-11T09:00:00Z", "alps", "s2"),
      event("2026-02-11T09:00:00Z", "pyrenees", "s3"),
      event("2026-02-17T09:00:00Z", "alps", "s1"),
    ], bookingsByZoneWeek, { read: readEventKey });
    expect(result.x).toEqual(["2026-02-09", "2026-02-16"]);
    expect(result.y).toEqual(["alps", "pyrenees"]);
    expect(result.cells.find((c) => c.x === "2026-02-09" && c.y === "alps")!.values).toEqual({ bookings: 3, suppliers: 2 });
  });

  it("re-aggregates pre-grouped dataset rows by summing the aliases", () => {
    const spec = AggregateSpecSchema.parse({
      source: { from: "dataset", record_type: "customer" },
      x: { key: "signup_date", bucket: "month" },
      measures: [{ as: "signups", op: "count" }, { as: "mrr", op: "sum", key: "mrr" }],
    });
    const result = aggregateRows([
      { signup_date: "2026-01-03", signups: 2, mrr: 20 },
      { signup_date: "2026-01-20", signups: 1, mrr: 10 },
      { signup_date: "2026-03-01", signups: 4, mrr: 0 },
    ], spec, { preAggregated: true });
    expect(result.cells).toEqual([
      { x: "2026-01-01", y: null, values: { signups: 3, mrr: 30 } },
      { x: "2026-03-01", y: null, values: { signups: 4, mrr: 0 } },
    ]);
    const series = aggregateSeries(result, "signups", "month");
    // February had no signups: 0, not a missing point.
    expect(series.map((p) => [p.period, p.value])).toEqual([["2026-01-01", 3], ["2026-02-01", 0], ["2026-03-01", 4]]);
    // No data a year back: null, never 0.
    expect(series[0]!.year_ago).toBeNull();
  });

  it("fills year-ago values when the data reaches back", () => {
    const spec = AggregateSpecSchema.parse({
      source: { from: "events", types: ["booking.created"] },
      x: { key: "occurred_at", bucket: "month" },
      measures: [{ as: "gmv", op: "sum", key: "amount" }],
    });
    const result = aggregateRows([
      event("2025-02-10T00:00:00Z", "alps", "s1", 50),
      event("2026-02-10T00:00:00Z", "alps", "s1", 80),
    ], spec, { read: readEventKey });
    const series = aggregateSeries(result, "gmv", "month");
    expect(series.at(-1)).toEqual({ period: "2026-02-01", value: 80, year_ago: 50 });
    expect(series).toHaveLength(13);
  });

  it("refuses count_distinct on a dataset", () => {
    expect(AggregateSpecSchema.safeParse({
      source: { from: "dataset", record_type: "customer" },
      x: { key: "plan" },
      measures: [{ as: "n", op: "count_distinct", key: "email" }],
    }).success).toBe(false);
  });
});

describe("heatmap", () => {
  it("builds a full grid coloured by ratio", () => {
    const result = aggregateRows([
      event("2026-02-09T09:00:00Z", "alps", "s1"),
      event("2026-02-10T09:00:00Z", "alps", "s1"),
      event("2026-02-11T09:00:00Z", "pyrenees", "s3"),
      event("2026-02-17T09:00:00Z", "pyrenees", "s3"),
    ], bookingsByZoneWeek, { read: readEventKey });
    const grid = heatmapGrid(result, { value: "bookings", second: "suppliers", color_by: "ratio" });
    expect(grid.rows).toEqual(["alps", "pyrenees"]);
    expect(grid.columns).toEqual(["2026-02-09", "2026-02-16"]);
    const alps = grid.cells[0]!;
    expect(alps[0]).toMatchObject({ value: 2, second: 1, ratio: 2, intensity: 1 });
    expect(alps[1]).toMatchObject({ value: null, intensity: null });
    expect(grid.cells[1]![0]).toMatchObject({ ratio: 1, intensity: 0 });
  });

  it("validates layouts and names the dataset types they read", () => {
    expect(businessLayoutIssues({ renderer: "heatmap", layout: {} })).toEqual(["layout.heatmap is required for the heatmap renderer"]);
    expect(businessLayoutIssues({ renderer: "heatmap", layout: { heatmap: { aggregate: bookingsByZoneWeek, value: "nope" } } })[0]).toMatch(/value `nope`/);
    expect(businessLayoutIssues({ renderer: "table", layout: { anything: 1 } })).toEqual([]);
    expect(layoutDatasetTypes({
      renderer: "metrics",
      layout: { metrics: { charts: [{ title: "Signups", aggregate: { source: { from: "dataset", record_type: "customer" }, x: { key: "signup_date", bucket: "week" }, measures: [{ as: "n", op: "count" }] } }] } },
    })).toEqual(["customer"]);
  });
});
