/**
 * Business templates through their routes on a demo workspace: applying is
 * additive and idempotent, a person's edits survive a re-apply, and creating
 * a workspace with a business model applies its template.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { listViews, resetDemoViewsForTests } from "@/lib/views/store";
import { _resetDemoBusiness, deleteRecordType, getBusinessSettings, listRecordTypes, updateRecordType } from "@/lib/business/record-types";
import { _resetDemoEvents, insertEvents } from "@/lib/business/events";
import { GET, POST } from "./route";
import { POST as CREATE_WORKSPACE } from "../../../route";
import { GET as TIMELINE } from "../../timeline/route";
import { POST as PROMOTE } from "../../../../nodes/[id]/dataset/promote/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const admin = { type: "demo" as const, id: "demo", isAdmin: true, canWrite: true };

let slug: string;
const apply = (body: unknown) => POST(request(`/api/workspaces/${slug}/business/template`, "POST", body), { params: Promise.resolve({ ws: slug }) }).then(json);

describe("business templates", () => {
  beforeEach(() => {
    resetDemoViewsForTests();
    _resetDemoBusiness();
    _resetDemoEvents();
    slug = `biz-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Template", slug });
  });

  it("applies b2b once, then has nothing left to do", async () => {
    const first = await apply({ business_model: "b2b" });
    expect(first.status).toBe(201);
    expect(first.body.created.record_types).toEqual(["account", "contact", "deal", "request"]);
    expect(first.body.created.views.map((v: { key: string }) => v.key)).toEqual(["pipeline", "accounts", "renewals", "requests", "metrics", "expenses"]);
    expect(first.body.skipped).toEqual([]);

    const storage = resolveDemoStorage(slug)!;
    const views = await listViews(storage, admin);
    const pipeline = views.find((view) => view.presentation.layout.template === "b2b:pipeline")!;
    expect(pipeline).toMatchObject({ visibility: "workspace", query: { kinds: ["deal"] }, presentation: { renderer: "board", group_by: "field:stage" } });

    const again = await apply({ business_model: "b2b" });
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual({ record_types: [], datasets: [], views: [] });
    expect(again.body.skipped).toHaveLength(10);
    expect(await listViews(storage, admin)).toHaveLength(views.length);
  });

  it("never overwrites what people changed, and skips a view that no longer fits", async () => {
    const storage = resolveDemoStorage(slug)!;
    await apply({ business_model: "b2b" });
    await updateRecordType(storage, "account", { label: "Client", fields: [{ key: "status", label: "Status", type: "select", options: ["live", "gone"] }] });

    const plan = await GET(request(`/api/workspaces/${slug}/business/template?business_model=b2b`), { params: Promise.resolve({ ws: slug }) }).then(json);
    expect(plan.body.create_record_types).toEqual([]);

    const types = await listRecordTypes(storage);
    expect(types.find((type) => type.key === "account")).toMatchObject({ label: "Client" });
  });

  it("validates the model, and product is a no-op", async () => {
    expect((await apply({ business_model: "nope" })).status).toBe(400);
    const product = await apply({});
    expect(product.status).toBe(200);
    expect(product.body).toMatchObject({ model: "product", created: { record_types: [], views: [] } });
  });

  it("creates the datasets behind dataset-backed types, and reuses them on a retry", async () => {
    const applied = await apply({ business_model: "marketplace" });
    expect(applied.body.created.record_types).toEqual(["segment", "zone", "incident", "request", "supplier", "buyer"]);
    expect(applied.body.created.datasets.map((d: { record_type: string; reused: boolean }) => `${d.record_type}:${d.reused}`)).toEqual(["supplier:false", "buyer:false"]);
    expect(applied.body.created.views.map((v: { key: string }) => v.key)).toEqual(["metrics", "supply-demand", "suppliers", "incidents", "requests", "expenses"]);

    const storage = resolveDemoStorage(slug)!;
    const supplier = (await listRecordTypes(storage)).find((type) => type.key === "supplier")!;
    const dataset = await storage.getNode(supplier.dataset_node_id!);
    expect(dataset).toMatchObject({ kind: "data", title: "Suppliers" });

    // A run that made the dataset but not the type (it failed in between):
    // the next run binds the same dataset instead of making a second one.
    await deleteRecordType(storage, "supplier");
    const retry = await apply({ business_model: "marketplace" });
    expect(retry.body.created.datasets).toEqual([{ record_type: "supplier", node_id: dataset!.id, reused: true }]);
    expect((await storage.listNodes({ kinds: ["data"] })).filter((node) => node.title === "Suppliers")).toHaveLength(1);
  });

  it("creates a workspace with a business model and its template", async () => {
    const created = await CREATE_WORKSPACE(request("/api/workspaces", "POST", { name: `Agency ${Date.now()}`, business_model: "b2b" })).then(json);
    expect(created.status).toBe(201);
    expect(created.body.business_template.created.record_types).toEqual(["account", "contact", "deal", "request"]);
    const storage = resolveDemoStorage(created.body.workspace.slug)!;
    expect((await getBusinessSettings(storage)).business_model).toBe("b2b");
  });
});

describe("timeline and promote", () => {
  beforeEach(() => {
    _resetDemoEvents();
    _resetDemoBusiness();
    slug = `biz-tl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Timeline", slug });
  });

  it("lists a subject's events newest first, including a supplier's bookings", async () => {
    const storage = resolveDemoStorage(slug)!;
    await insertEvents(storage, [
      { type: "subscription.started", occurred_at: "2026-01-01T00:00:00Z", idempotency_key: "a", subject_id: "acme", amount: 200, currency: "EUR" },
      { type: "subscription.changed", occurred_at: "2026-03-01T00:00:00Z", idempotency_key: "b", subject_id: "acme", amount: 450, currency: "EUR" },
      { type: "booking.created", occurred_at: "2026-02-01T00:00:00Z", idempotency_key: "c", subject_id: "buyer-1", amount: 80, currency: "EUR", properties: { booking_id: "bk1", supplier_id: "acme" } },
      { type: "subscription.started", occurred_at: "2026-02-01T00:00:00Z", idempotency_key: "d", subject_id: "other", amount: 10, currency: "EUR" },
    ], null);
    const timeline = (q: string) => TIMELINE(request(`/api/workspaces/${slug}/timeline?${q}`), { params: Promise.resolve({ ws: slug }) }).then(json);
    const answer = await timeline("subject_id=acme&limit=2");
    expect(answer.status).toBe(200);
    expect(answer.body.events.map((e: { type: string; role: string }) => `${e.type}/${e.role}`)).toEqual(["subscription.changed/subject", "booking.created/supplier"]);
    expect(answer.body.more).toBe(true);
    expect((await timeline("limit=2")).status).toBe(400);
  });

  it("promote refuses an unknown record type with a JSON error the web can show", async () => {
    const res = await PROMOTE(request("/api/nodes/n1/dataset/promote", "POST", { workspace: slug, key: "c_1", record_type: "nope" }), { params: Promise.resolve({ id: "n1" }) }).then(json);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown kind `nope`/);
  });
});
