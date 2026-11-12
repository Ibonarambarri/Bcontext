/**
 * The ingest API through its real routes and its real door
 * (`openIngestWorkspace`), on a demo workspace. Only the key lookup is
 * faked — it is a hash lookup in `ingest_keys` — so what is under test is
 * everything around it: who gets in, what a write does, what a retry does,
 * what erasure removes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("@/lib/business/ingest-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/business/ingest-keys")>()),
  verifyIngestKey: async (header: string | null) =>
    header === "Bearer bctx_ingest_good" ? { id: "key-1", workspaceId: keys.workspaceId } : null,
}));

import { parseAuthHeader } from "@/lib/auth/tokens";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { _resetRateLimit } from "@/lib/rate-limit";
import { _resetDemoBusiness, createRecordType } from "@/lib/business/record-types";
import { _resetDemoEvents, loadRollupEvents } from "@/lib/business/events";
import { findRecordNode } from "@/lib/business/records";
import * as batchRoute from "./[type]/route";
import * as oneRoute from "./[type]/[external_id]/route";
import * as eventsRoute from "../events/route";

let slug: string;

function request(method: string, path: string, body?: unknown, key = "bctx_ingest_good") {
  return new Request(`http://localhost/api/workspaces/${slug}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const put = (id: string, body: unknown, key?: string) =>
  oneRoute.PUT(request("PUT", `/records/account/${id}`, body, key), { params: Promise.resolve({ ws: slug, type: "account", external_id: id }) }).then(json);
const events = (body: unknown, key?: string) =>
  eventsRoute.POST(request("POST", "/events", body, key), { params: Promise.resolve({ ws: slug }) }).then(json);

describe("ingest API", () => {
  beforeEach(async () => {
    _resetRateLimit();
    _resetDemoBusiness();
    _resetDemoEvents();
    slug = `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Denak", slug });
    keys.workspaceId = workspace.id;
    await createRecordType(resolveDemoStorage(slug)!, {
      key: "account",
      label: "Account",
      fields: [
        { key: "mrr", label: "MRR", type: "money", required: true },
        { key: "plan", label: "Plan", type: "select", options: ["starter", "pro"] },
      ],
    }, null);
  });

  it("only lets an ingest key in, and only into its own workspace", async () => {
    expect((await put("acc_1", { fields: {} }, "bctx_ingest_wrong")).status).toBe(401);
    expect((await put("acc_1", { fields: {} }, "bctx_live_notaningestkey")).status).toBe(401);
    keys.workspaceId = "another-workspace";
    expect((await put("acc_1", { fields: {} })).status).toBe(404);
  });

  it("is useless everywhere else: the bearer parser of every other route rejects it", () => {
    expect(parseAuthHeader("Bearer bctx_ingest_good")).toBeNull();
    expect(parseAuthHeader("Bearer bctx_live_abc")).toBe("bctx_live_abc");
  });

  it("upserts a record by external id: created, unchanged, updated", async () => {
    const created = await put("acc_1", { title: "Acme", fields: { mrr: { amount: 490, currency: "EUR" }, plan: "pro" } });
    expect(created).toMatchObject({ status: 201, body: { status: "created", external_id: "acc_1" } });
    const node = (await findRecordNode(resolveDemoStorage(slug)!, "account", "acc_1"))!;
    expect(node).toMatchObject({ id: created.body.node_id, kind: "account", title: "Acme" });

    expect((await put("acc_1", { fields: { plan: "pro" } })).body.status).toBe("unchanged");
    const updated = await put("acc_1", { fields: { plan: "starter" } });
    expect(updated).toMatchObject({ status: 200, body: { status: "updated", node_id: node.id } });
    const after = (await findRecordNode(resolveDemoStorage(slug)!, "account", "acc_1"))!;
    expect(after.data).toMatchObject({ external_id: "acc_1", fields: { mrr: { amount: 490, currency: "EUR" }, plan: "starter" } });
  });

  it("names the bad field, and needs required fields only on create", async () => {
    const missing = await put("acc_2", { fields: { plan: "pro" } });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toContain("field `mrr`: is required");
    const badType = await put("acc_2", { fields: { mrr: { amount: 1, currency: "EUR" }, plan: "gold" } });
    expect(badType.body.error).toContain("starter | pro");
  });

  it("batches records, reporting each slot", async () => {
    const res = await batchRoute.POST(
      request("POST", "/records/account", {
        records: [
          { external_id: "a", fields: { mrr: { amount: 1, currency: "EUR" } } },
          { external_id: "b", fields: { mrr: "lots" } },
        ],
      }),
      { params: Promise.resolve({ ws: slug, type: "account" }) },
    ).then(json);
    expect(res.body).toMatchObject({ created: 1, invalid: 1 });
    expect(res.body.results[1].error).toContain("field `mrr`");

    const unknownType = await batchRoute.POST(
      request("POST", "/records/deal", { records: [{ external_id: "d", fields: {} }] }),
      { params: Promise.resolve({ ws: slug, type: "deal" }) },
    ).then(json);
    expect(unknownType.status).toBe(404);
  });

  it("stores events once per idempotency key and checks canonical ones", async () => {
    const event = {
      type: "subscription.started",
      occurred_at: "2026-11-01T10:00:00Z",
      idempotency_key: "sub_1:started",
      subject_type: "account",
      subject_id: "acc_1",
      amount: 490,
      currency: "EUR",
    };
    expect((await events(event)).body).toMatchObject({ stored: 1, duplicates: 0 });
    expect((await events(event)).body).toMatchObject({ stored: 0, duplicates: 1 });

    const batch = await events({
      events: [
        { ...event, idempotency_key: "sub_1:changed", type: "subscription.changed", amount: 590 },
        { ...event, idempotency_key: "bad", amount: undefined },
        { type: "feature.used", occurred_at: "2026-11-02T10:00:00Z", idempotency_key: "f1", properties: { feature: "export" } },
        { ...event, idempotency_key: "sub_1:changed", type: "subscription.changed", amount: 590 },
      ],
    });
    expect(batch.status).toBe(200);
    expect(batch.body.results.map((r: { status: string }) => r.status)).toEqual(["stored", "invalid", "stored", "duplicate"]);
    expect(batch.body.results[1].error).toContain("needs an amount");

    const single = await events({ ...event, idempotency_key: "x", type: "booking.created" });
    expect(single.status).toBe(422);
    expect((await loadRollupEvents(resolveDemoStorage(slug)!)).map((e) => e.type)).toEqual(["subscription.started", "subscription.changed"]);
  });

  it("erases a subject: the record goes, its events keep their amounts and lose the link", async () => {
    await put("acc_9", { title: "Person-ish", fields: { mrr: { amount: 9, currency: "EUR" } } });
    await events({ type: "subscription.started", occurred_at: "2026-11-01T10:00:00Z", idempotency_key: "s9", subject_type: "account", subject_id: "acc_9", amount: 9, currency: "EUR" });
    const erased = await oneRoute.DELETE(request("DELETE", "/records/account/acc_9"), {
      params: Promise.resolve({ ws: slug, type: "account", external_id: "acc_9" }),
    }).then(json);
    expect(erased.body).toEqual({ external_id: "acc_9", record_removed: true, events_unlinked: 1 });
    expect(await findRecordNode(resolveDemoStorage(slug)!, "account", "acc_9")).toBeNull();
    const [stored] = await loadRollupEvents(resolveDemoStorage(slug)!);
    expect(stored).toMatchObject({ amount: 9 });
    expect(stored!.subject_id).toMatch(/^erased:/);
  });
});
