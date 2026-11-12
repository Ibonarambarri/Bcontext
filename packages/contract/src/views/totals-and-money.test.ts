import { describe, expect, it } from "vitest";
import type { RecordFieldDef } from "../business/record-types.js";
import { BUSINESS_TEMPLATES } from "../business/templates.js";
import { columnSummary, displayFieldValue, fieldTotalOf, formatMoney, headlineTotal, totalText, totalsFor, type RecordRow } from "./fields.js";

/**
 * v0.4.2 browser pass: an Instructors table printed "Σ 78.1" under its
 * ratings, and a timeline printed "€90.00" next to "€150". A total is only
 * shown where it means something, and money has one decimals rule.
 */

const row = (id: string, fields: RecordRow["fields"]): RecordRow => ({ id, title: id, type: "supplier", fields });

describe("fieldTotalOf", () => {
  it("sums money and counts, averages grades and rates, skips labels", () => {
    expect(fieldTotalOf({ key: "mrr", type: "money" })).toBe("sum");
    expect(fieldTotalOf({ key: "seats", type: "number" })).toBe("sum");
    expect(fieldTotalOf({ key: "bookings", type: "number" })).toBe("sum");
    expect(fieldTotalOf({ key: "rating", type: "number" })).toBe("average");
    expect(fieldTotalOf({ key: "nps_score", type: "number" })).toBe("average");
    expect(fieldTotalOf({ key: "win_probability", type: "number" })).toBe("average");
    expect(fieldTotalOf({ key: "conversion_rate", type: "number" })).toBe("average");
    expect(fieldTotalOf({ key: "founded_year", type: "number" })).toBe("none");
    expect(fieldTotalOf({ key: "rank", type: "number" })).toBe("none");
    expect(fieldTotalOf({ key: "name", type: "text" })).toBeNull();
  });

  it("lets the definition say otherwise", () => {
    expect(fieldTotalOf({ key: "rating", type: "number", total: "sum" })).toBe("sum");
    expect(fieldTotalOf({ key: "mrr", type: "money", total: "average" })).toBe("average");
    expect(fieldTotalOf({ key: "seats", type: "number", total: "none" })).toBe("none");
  });

  it("is explicit in the templates where a sum would mislead", () => {
    const supplier = BUSINESS_TEMPLATES.marketplace.record_types.find((type) => type.key === "supplier")!;
    expect(supplier.fields.find((field) => field.key === "rating")!.total).toBe("average");
    const deal = BUSINESS_TEMPLATES.b2b.record_types.find((type) => type.key === "deal")!;
    expect(deal.fields.find((field) => field.key === "probability")!.total).toBe("average");
  });
});

describe("table totals", () => {
  const fields: RecordFieldDef[] = [
    { key: "rating", label: "Rating", type: "number" },
    { key: "bookings", label: "Bookings", type: "number" },
    { key: "joined_year", label: "Joined", type: "number" },
    { key: "payout", label: "Payout", type: "money" },
  ];
  const rows = [
    row("a", { rating: 4.8, bookings: 10, joined_year: 2024, payout: { amount: 900, currency: "EUR" } }),
    row("b", { rating: 4.5, bookings: 3, joined_year: 2025, payout: { amount: 49.5, currency: "EUR" } }),
    row("c", { rating: null, bookings: 7 }),
  ];

  it("averages a rating over the rows that have one, and never sums it", () => {
    const totals = totalsFor(fields, rows);
    const rating = totals.totals.find((t) => t.field === "rating")!;
    expect(rating).toMatchObject({ op: "average", count: 2 });
    expect(rating.average).toBeCloseTo(4.65);
    expect(totalText(rating)).toBe("avg 4.7");
    expect(totalText(totals.totals.find((t) => t.field === "bookings")!)).toBe("Σ 20");
    expect(totalText(totals.totals.find((t) => t.field === "payout")!)).toBe("Σ €949.50");
    expect(totals.totals.find((t) => t.field === "joined_year")).toBeUndefined();
  });

  it("heads a board column with a sum, not an average, unless the layout names it", () => {
    const totals = totalsFor(fields, rows);
    expect(headlineTotal(totals)?.field).toBe("payout");
    const ratingOnly = totalsFor([fields[0]!], rows);
    expect(headlineTotal(ratingOnly)).toBeNull();
    const named = headlineTotal(ratingOnly, "rating");
    expect(columnSummary("Active", ratingOnly, named)).toBe("Active · 3 · avg 4.7");
  });

  it("prints nothing for a column no row fills", () => {
    const totals = totalsFor(fields, [row("x", {})]);
    expect(totalText(totals.totals.find((t) => t.field === "rating")!)).toBe("");
    expect(totalText(totals.totals.find((t) => t.field === "bookings")!)).toBe("");
  });
});

describe("formatMoney", () => {
  it("shows cents only when there are some, with both digits", () => {
    expect(formatMoney(90, "EUR")).toBe("€90");
    expect(formatMoney(150, "EUR")).toBe("€150");
    expect(formatMoney(49.9, "EUR")).toBe("€49.90");
    expect(formatMoney(9.99, "EUR")).toBe("€9.99");
    // Cents that round away are not cents.
    expect(formatMoney(45.0004, "EUR")).toBe("€45");
    expect(formatMoney(-12.5, "EUR")).toBe("-€12.50");
  });

  it("rounds from a thousand up, and is compact only when asked", () => {
    expect(formatMoney(1240.5, "EUR")).toBe("€1,241");
    expect(formatMoney(182_000, "EUR")).toBe("€182,000");
    expect(formatMoney(182_000, "EUR", { compact: true })).toBe("€182K");
    expect(formatMoney(12_340, "USD", { compact: true })).toBe("$12.3K");
  });

  it("keeps a locale string as before, and survives an unknown currency", () => {
    expect(formatMoney(2100, "EUR", "en-GB")).toBe("€2,100");
    expect(formatMoney(5, "XXQ")).toContain("XXQ");
  });
});

/**
 * v0.4.3: a B2C customer's MRR lives in a dataset row, which cannot hold
 * `{ amount, currency }`, so it is a number — and its cells read "9.99".
 * `unit: "money"` prints it in the reporting currency.
 */
describe("number fields shown as money", () => {
  const mrr: RecordFieldDef = { key: "mrr", label: "MRR", type: "number", unit: "money" };
  const rows = [row("cus_1", { mrr: 9.99 }), row("cus_2", { mrr: 4.99 }), row("cus_3", {})];

  it("prints the cell in the reporting currency, and stays a number without one", () => {
    expect(displayFieldValue(mrr, 9.99, { currency: "EUR" })).toEqual({ kind: "text", text: "€9.99" });
    expect(displayFieldValue(mrr, 1990, { currency: "USD" })).toEqual({ kind: "text", text: "$1,990" });
    expect(displayFieldValue(mrr, 9.99)).toEqual({ kind: "text", text: "9.99" });
    expect(displayFieldValue({ type: "number" }, 9.99, { currency: "EUR" })).toEqual({ kind: "text", text: "9.99" });
  });

  it("sums the footer and the board header as money", () => {
    expect(fieldTotalOf(mrr)).toBe("sum");
    const totals = totalsFor([mrr], rows, { currency: "EUR" });
    expect(totals.totals[0]).toMatchObject({ field: "mrr", type: "number", sum: 14.98, count: 2, currency: "EUR" });
    expect(totalText(totals.totals[0]!)).toBe("Σ €14.98");
    expect(columnSummary("Active", totals, headlineTotal(totals), "/mo")).toBe("Active · 3 · €14.98/mo");
    expect(totalText(totalsFor([mrr], rows).totals[0]!)).toBe("Σ 14.98");
  });

  it("is what the b2c template's customer MRR declares", () => {
    const customer = BUSINESS_TEMPLATES.b2c.record_types.find((type) => type.key === "customer")!;
    expect(customer.fields.find((field) => field.key === "mrr")).toMatchObject({ type: "number", unit: "money" });
  });
});
