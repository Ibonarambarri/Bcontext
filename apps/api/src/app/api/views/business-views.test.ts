/**
 * Views over record types through the real view routes on a demo workspace:
 * saving checks fields and dataset types by name, resolving applies field
 * filters and returns the records / metrics / heatmap payloads the web draws.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";
import { _resetDemoBusiness, createRecordType } from "@/lib/business/record-types";
import { _resetDemoEvents, insertEvents } from "@/lib/business/events";
import { POST as CREATE_VIEW } from "./route";
import { PATCH } from "./[id]/route";
import { POST as RESOLVE_VIEW } from "./[id]/resolve/route";
import { POST as RESOLVE_QUERY } from "./resolve/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });

let slug: string;

async function setup() {
  slug = `biz-views-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: "Biz views", slug });
  const storage = resolveDemoStorage(slug)!;
  await createRecordType(storage, {
    key: "deal",
    label: "Deal",
    stage_field: "stage",
    fields: [
      { key: "stage", label: "Stage", type: "select", options: ["lead", "proposal", "won"], required: true },
      { key: "amount", label: "Amount", type: "money" },
      { key: "close_date", label: "Close", type: "date" },
    ],
  }, null);
  const deal = (title: string, fields: Record<string, unknown>) => storage.createNode({ title, kind: "deal", parent_id: null, data: { fields } });
  const a = await deal("Acme", { stage: "proposal", amount: { amount: 1200, currency: "EUR" }, close_date: "2026-12-01" });
  const b = await deal("Globex", { stage: "proposal", amount: { amount: 900, currency: "EUR" } });
  const c = await deal("Initech", { stage: "lead" });
  return { storage, ids: { a: a.id, b: b.id, c: c.id } };
}

const create = (name: string, query: object, presentation: object) =>
  CREATE_VIEW(request("/api/views", "POST", { workspace: slug, name, visibility: "workspace", query: { schema_version: 1, ...query }, presentation: { schema_version: 1, ...presentation } })).then(json);
const resolve = (id: string) =>
  RESOLVE_VIEW(request(`/api/views/${id}/resolve?workspace=${slug}`, "POST"), { params: Promise.resolve({ id }) }).then(json);

describe("views over record types", () => {
  beforeEach(() => {
    resetDemoViewsForTests();
    _resetDemoBusiness();
    _resetDemoEvents();
  });

  it("refuses fields and dataset types the workspace does not have, naming what exists", async () => {
    await setup();
    const badFilter = await create("Bad", { kinds: ["deal"], field_filters: [{ field: "mrr", op: "gt", value: 1 }] }, { renderer: "table" });
    expect(badFilter.status).toBe(400);
    expect(badFilter.body.message).toMatch(/`mrr` is not a field of deal \(fields: stage, amount, close_date\)/);

    const badColumn = await create("Bad cols", { kinds: ["deal"] }, { renderer: "table", columns: ["field:nope"] });
    expect(badColumn.status).toBe(400);
    expect(badColumn.body.message).toMatch(/field:nope/);

    const badDataset = await create("Bad ds", { dataset_type: "deal" }, { renderer: "table" });
    expect(badDataset.status).toBe(400);
    expect(badDataset.body.message).toMatch(/not a dataset-backed record type/);

    const badLayout = await create("Bad heat", {}, { renderer: "heatmap" });
    expect(badLayout.status).toBe(400);
    expect(badLayout.body.message).toMatch(/layout.heatmap is required/);

    const adHoc = await RESOLVE_QUERY(request("/api/views/resolve", "POST", { workspace: slug, query: { schema_version: 1, kinds: ["deal"], field_filters: [{ field: "x", op: "eq", value: 1 }] } })).then(json);
    expect(adHoc.status).toBe(400);
  });

  it("checks a presentation-only update against the stored query", async () => {
    await setup();
    const view = (await create("Pipeline", { kinds: ["deal"] }, { renderer: "board", group_by: "field:stage" })).body.view;
    const patched = await PATCH(request(`/api/views/${view.id}`, "PATCH", { workspace: slug, expected_version: view.version, presentation: { schema_version: 1, renderer: "board", group_by: "field:nope" } }), { params: Promise.resolve({ id: view.id }) });
    expect(patched.status).toBe(400);
  });

  it("resolves a pipeline board with records and their fields, and applies field filters", async () => {
    const { ids } = await setup();
    const view = (await create("Pipeline", { kinds: ["deal"] }, { renderer: "board", group_by: "field:stage", columns: ["field:amount"] })).body.view;
    const resolved = await resolve(view.id);
    expect(resolved.status).toBe(200);
    expect(resolved.body.result.node_ids).toHaveLength(3);
    expect(resolved.body.records.types.map((t: { key: string }) => t.key)).toEqual(["deal"]);
    expect(resolved.body.records.currency).toBe("EUR");
    const acme = resolved.body.records.rows.find((row: { id: string }) => row.id === ids.a);
    expect(acme).toMatchObject({ title: "Acme", type: "deal", fields: { stage: "proposal", amount: { amount: 1200, currency: "EUR" } } });

    const filtered = (await create("Proposals", { kinds: ["deal"], field_filters: [{ field: "stage", op: "eq", value: "proposal" }, { field: "close_date", op: "empty", value: true }] }, { renderer: "table" })).body.view;
    const answer = await resolve(filtered.id);
    expect(answer.body.result.node_ids).toEqual([ids.b]);
    expect(answer.body.records.rows.map((row: { id: string }) => row.id)).toEqual([ids.b]);

    const big = await RESOLVE_QUERY(request("/api/views/resolve", "POST", { workspace: slug, query: { schema_version: 1, kinds: ["deal"], field_filters: [{ field: "amount", op: "gt", value: 1000 }] } })).then(json);
    expect(big.body.result.node_ids).toEqual([ids.a]);
  });

  it("leaves task views alone: no business payload", async () => {
    await setup();
    const view = (await create("Tasks", { kinds: ["task"] }, { renderer: "list" })).body.view;
    const resolved = await resolve(view.id);
    expect(resolved.body.records).toBeUndefined();
  });

  it("computes a heatmap and a YoY chart from business events", async () => {
    const { storage } = await setup();
    const booking = (key: string, at: string, zone: string, supplier: string, amount: number, currency = "EUR") => ({
      type: "booking.created",
      occurred_at: at,
      idempotency_key: key,
      subject_id: `buyer-${key}`,
      amount,
      currency,
      properties: { booking_id: key, supplier_id: supplier, zone, fee: 10 },
    });
    await insertEvents(storage, [
      booking("1", "2026-02-09T10:00:00Z", "alps", "s1", 100),
      booking("2", "2026-02-10T10:00:00Z", "alps", "s1", 100),
      booking("3", "2026-02-11T10:00:00Z", "alps", "s2", 100),
      booking("4", "2026-02-11T10:00:00Z", "pyrenees", "s3", 100),
      booking("5", "2025-02-10T10:00:00Z", "alps", "s1", 50),
      booking("6", "2026-02-12T10:00:00Z", "alps", "s1", 999, "USD"),
    ], null);
    const aggregate = {
      source: { from: "events", types: ["booking.created"] },
      x: { key: "occurred_at", bucket: "week" },
      y: { key: "zone" },
      measures: [{ as: "bookings", op: "count" }, { as: "suppliers", op: "count_distinct", key: "supplier_id" }],
      since: "2026-01-01",
    };
    const heat = (await create("Supply", {}, { renderer: "heatmap", layout: { heatmap: { aggregate, value: "bookings", second: "suppliers", color_by: "ratio" } } })).body.view;
    const resolved = await resolve(heat.id);
    expect(resolved.status).toBe(200);
    const cell = resolved.body.heatmap.result.cells.find((c: { x: string; y: string }) => c.x === "2026-02-09" && c.y === "alps");
    expect(cell.values).toEqual({ bookings: 4, suppliers: 2 });

    const metrics = (await create("GMV", {}, {
      renderer: "metrics",
      layout: { metrics: { compare: "year_ago", charts: [{ title: "GMV", unit: "money", yoy: true, aggregate: { source: { from: "events", types: ["booking.created"] }, x: { key: "occurred_at", bucket: "month" }, measures: [{ as: "gmv", op: "sum", key: "amount" }] } }] } },
    })).body.view;
    const answer = await resolve(metrics.id);
    expect(answer.status).toBe(200);
    const chart = answer.body.metrics.charts[0];
    // The USD booking is left out of a sum in the EUR reporting currency.
    const feb = chart.result.cells.find((c: { x: string }) => c.x === "2026-02-01");
    expect(feb.values.gmv).toBe(400);
    expect(chart.result.cells.find((c: { x: string }) => c.x === "2025-02-01").values.gmv).toBe(50);
    expect(answer.body.metrics.summary).not.toBeNull();
  });
});
