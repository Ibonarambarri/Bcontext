import { describe, expect, it } from "vitest";
import type { RecordTypeDefinition } from "../business/record-types.js";
import { matchesFieldFilters } from "../business/record-types.js";
import {
  NO_VALUE_COLUMN,
  columnSummary,
  displayFieldValue,
  groupRecordRows,
  headlineTotal,
  recordBoardColumns,
  recordBoardField,
  recordMovePatch,
  recordTableColumns,
  recordViewFieldRefs,
  sortRecordRows,
  totalsFor,
  type RecordRow,
} from "./fields.js";
import { normalizeViewPresentation, normalizeViewQuery, parseFieldRef } from "./schema.js";

const deal: RecordTypeDefinition = {
  key: "deal",
  label: "Deal",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "stage", label: "Stage", type: "select", options: ["lead", "demo", "proposal", "won"], required: true },
    { key: "amount", label: "Amount", type: "money" },
    { key: "probability", label: "Probability", type: "number" },
    { key: "account", label: "Account", type: "relation", target: "account" },
    { key: "close_date", label: "Close", type: "date" },
  ],
};

const row = (id: string, fields: RecordRow["fields"], title = id): RecordRow => ({ id, title, type: "deal", fields });

const rows = [
  row("a", { stage: "proposal", amount: { amount: 1200, currency: "EUR" }, probability: 50 }),
  row("b", { stage: "proposal", amount: { amount: 900, currency: "EUR" } }),
  row("c", { stage: "lead", probability: 10 }),
  row("d", { stage: "lost-ish" as never }),
];

describe("schema additions", () => {
  it("parses field refs and keeps old views valid", () => {
    expect(parseFieldRef("field:mrr")).toBe("mrr");
    expect(parseFieldRef("status")).toBeNull();
    const query = normalizeViewQuery({ schema_version: 1, kinds: ["task"] });
    expect(query.field_filters).toEqual([]);
    expect(query.dataset_type).toBeNull();
    const presentation = normalizeViewPresentation({ schema_version: 1, renderer: "board", sort_by: [{ field: "field:amount", direction: "desc" }] });
    expect(presentation.sort_by[0]!.field).toBe("field:amount");
  });

  it("refuses node filters beside dataset_type", () => {
    expect(() => normalizeViewQuery({ schema_version: 1, dataset_type: "customer", kinds: ["task"] })).toThrow(/dataset_type/);
    expect(normalizeViewQuery({ schema_version: 1, dataset_type: "customer", field_filters: [{ field: "plan", op: "eq", value: "pro" }] }).dataset_type).toBe("customer");
  });

  it("accepts the metrics and heatmap renderers and refuses a bad sort ref", () => {
    expect(normalizeViewPresentation({ schema_version: 1, renderer: "metrics" }).renderer).toBe("metrics");
    expect(() => normalizeViewPresentation({ schema_version: 1, renderer: "table", sort_by: [{ field: "field:Bad Key" }] })).toThrow();
  });

  it("filters on empty / not empty", () => {
    expect(matchesFieldFilters({}, [{ field: "close_date", op: "empty", value: true }])).toBe(true);
    expect(matchesFieldFilters({ close_date: "2026-01-01" }, [{ field: "close_date", op: "empty", value: true }])).toBe(false);
    expect(matchesFieldFilters({ close_date: "2026-01-01" }, [{ field: "close_date", op: "empty", value: false }])).toBe(true);
    expect(matchesFieldFilters({ tags: [] }, [{ field: "tags", op: "empty", value: true }])).toBe(true);
  });
});

describe("record board", () => {
  it("groups by the stage field by default, in option order, with a no-value column only when needed", () => {
    const field = recordBoardField([deal], { group_by: null })!;
    expect(field.key).toBe("stage");
    const columns = recordBoardColumns(field, rows);
    expect(columns.map((c) => c.value)).toEqual(["lead", "demo", "proposal", "won", NO_VALUE_COLUMN]);
    expect(recordBoardColumns(field, rows.slice(0, 3)).map((c) => c.value)).not.toContain(NO_VALUE_COLUMN);
    const groups = groupRecordRows(field, rows, columns);
    expect(groups.get("proposal")!.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groups.get(NO_VALUE_COLUMN)!.map((r) => r.id)).toEqual(["d"]);
  });

  it("is not a record board when group_by names a core column or a non-groupable field", () => {
    expect(recordBoardField([deal], { group_by: "status" })).toBeNull();
    expect(recordBoardField([deal], { group_by: "field:amount" })).toBeNull();
  });

  it("turns a drop into a fields patch", () => {
    const field = recordBoardField([deal], { group_by: "field:stage" })!;
    expect(recordMovePatch(field, rows[0]!, "won")).toEqual({ stage: "won" });
    expect(recordMovePatch(field, rows[0]!, "proposal")).toBeNull();
    expect(recordMovePatch(field, rows[0]!, "nope")).toBeNull();
    // required: cannot be cleared by dropping into "No value"
    expect(recordMovePatch(field, rows[0]!, NO_VALUE_COLUMN)).toBeNull();
  });
});

describe("totals", () => {
  it("sums money and numbers and prints the column summary", () => {
    const totals = totalsFor(deal.fields, rows.slice(0, 2));
    const headline = headlineTotal(totals, "amount");
    expect(headline).toMatchObject({ sum: 2100, currency: "EUR", count: 2 });
    expect(columnSummary("Proposal", totals, headline, "/mo", "en-GB")).toBe("Proposal · 2 · €2,100/mo");
  });

  it("never adds two currencies", () => {
    const totals = totalsFor(deal.fields, [
      row("x", { stage: "lead", amount: { amount: 1, currency: "EUR" } }),
      row("y", { stage: "lead", amount: { amount: 1, currency: "USD" } }),
    ]);
    const money = totals.totals.find((t) => t.field === "amount")!;
    expect(money).toMatchObject({ sum: null, mixed_currency: true });
    expect(columnSummary("Lead", totals, money)).toBe("Lead · 2 · mixed currencies");
  });
});

describe("table", () => {
  it("resolves field columns and keeps core ones", () => {
    const columns = recordTableColumns([deal], { columns: ["title", "field:amount", "field:unknown"] });
    expect(columns).toEqual([{ core: "title" }, { field: deal.fields[1] }]);
    expect(recordTableColumns([deal], { columns: [] })).toHaveLength(deal.fields.length + 1);
  });

  it("collects every field ref of a presentation", () => {
    expect(recordViewFieldRefs({ group_by: "field:stage", sort_by: [{ field: "field:amount", direction: "asc" }], columns: ["title", "field:stage"] }))
      .toEqual(["stage", "amount"]);
  });

  it("sorts selects by option order and money by amount, empties last", () => {
    expect(sortRecordRows(rows, [{ field: "field:stage", direction: "asc" }], [deal]).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortRecordRows(rows, [{ field: "field:amount", direction: "desc" }], [deal]).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("formats values for display", () => {
    expect(displayFieldValue({ type: "money" }, { amount: 450, currency: "EUR" }, "en-GB")).toEqual({ kind: "text", text: "€450" });
    expect(displayFieldValue({ type: "date" }, "2026-03-04", "en-GB")).toEqual({ kind: "text", text: "4 Mar 2026" });
    expect(displayFieldValue({ type: "select" }, "won")).toEqual({ kind: "chips", values: ["won"] });
    expect(displayFieldValue({ type: "relation" }, ["n1", "n2"])).toEqual({ kind: "relation", ids: ["n1", "n2"] });
    expect(displayFieldValue({ type: "url" }, "https://acme.com")).toEqual({ kind: "link", href: "https://acme.com", text: "acme.com" });
    expect(displayFieldValue({ type: "text" }, null)).toEqual({ kind: "empty" });
  });
});
