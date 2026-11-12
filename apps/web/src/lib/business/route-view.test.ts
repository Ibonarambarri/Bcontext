import { describe, expect, it } from "vitest";
import { normalizeViewPresentation, normalizeViewQuery } from "@bcontext-dev/contract/views/schema";
import type { RecordType } from "@bcontext-dev/contract/business/record-types";
import { businessSurface, isBusinessView } from "./route-view";

const view = (query: object, presentation: object) => ({
  query: normalizeViewQuery({ schema_version: 1, ...query }),
  presentation: normalizeViewPresentation({ schema_version: 1, ...presentation }),
});

const deal: RecordType = {
  id: "t1", workspace_id: "w", position: 0, created_at: "", updated_at: "",
  key: "deal", label: "Deal", storage: "node", stage_field: "stage",
  fields: [{ key: "stage", label: "Stage", type: "select", options: ["lead", "won"] }],
};

describe("isBusinessView", () => {
  it("leaves core views alone", () => {
    expect(isBusinessView(view({ kinds: ["task", "bug"] }, { renderer: "board" }))).toBe(false);
    expect(isBusinessView(view({}, { renderer: "list" }))).toBe(false);
    expect(isBusinessView(view({ kinds: ["deal"] }, { renderer: "graph" }))).toBe(false);
  });

  it("takes record kinds, datasets, field grouping and the business renderers", () => {
    expect(isBusinessView(view({ kinds: ["deal"] }, { renderer: "board" }))).toBe(true);
    expect(isBusinessView(view({ dataset_type: "customer" }, { renderer: "table" }))).toBe(true);
    expect(isBusinessView(view({}, { renderer: "metrics" }))).toBe(true);
    expect(isBusinessView(view({}, { renderer: "heatmap" }))).toBe(true);
    expect(isBusinessView(view({ kinds: ["task"] }, { renderer: "table", group_by: "field:x" }))).toBe(true);
  });
});

describe("businessSurface", () => {
  it("routes a record board by its stage field, and explains when it cannot", () => {
    const records = { types: [deal], rows: [], currency: "EUR" };
    expect(businessSurface(view({ kinds: ["deal"] }, { renderer: "board" }), { records })).toMatchObject({ kind: "record-board", field: { key: "stage" } });
    expect(businessSurface(view({ kinds: ["deal"] }, { renderer: "board", group_by: "status" }), { records }).kind).toBe("message");
    expect(businessSurface(view({ kinds: ["deal"] }, { renderer: "table" }), { records }).kind).toBe("record-table");
  });

  it("routes datasets and metrics", () => {
    expect(businessSurface(view({ dataset_type: "customer" }, { renderer: "table" }), {}).kind).toBe("message");
    expect(businessSurface(view({}, { renderer: "metrics" }), { metrics: { summary: null, charts: [] } }).kind).toBe("metrics");
  });
});
