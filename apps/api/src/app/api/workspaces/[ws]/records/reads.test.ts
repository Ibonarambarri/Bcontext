/**
 * The two business reads the web's record pages use: a type's records with
 * their fields (`GET /records/:type`) and one subject's events
 * (`GET /events?subject_type=&subject_id=`). Demo workspace, real routes;
 * `openWorkspace` is replaced by one that opens the demo storage, so what is
 * under test is what the routes do once the caller is in — and that the
 * ingest door is not the one they use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const door = vi.hoisted(() => ({ slug: "", denied: false }));
vi.mock("@/lib/auth/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace")>();
  const { resolveDemoStorage } = await import("@/lib/storage/demo");
  return {
    ...actual,
    openWorkspace: async () =>
      door.denied
        ? Response.json({ error: "not_found" }, { status: 404 })
        : { actor: { kind: "user", userId: "u1" }, storage: resolveDemoStorage(door.slug)! },
  };
});

import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { _resetDemoBusiness, createRecordType, getRecordType } from "@/lib/business/record-types";
import { _resetDemoEvents, insertEvents } from "@/lib/business/events";
import { upsertNodeRecord } from "@/lib/business/records";
import * as recordsRoute from "./[type]/route";
import * as eventsRoute from "../events/route";

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const listRecords = (type: string, query = "") =>
  recordsRoute.GET(new Request(`http://localhost/api/workspaces/${door.slug}/records/${type}${query}`), {
    params: Promise.resolve({ ws: door.slug, type }),
  }).then(json);
const listEvents = (query: string) =>
  eventsRoute.GET(new Request(`http://localhost/api/workspaces/${door.slug}/events${query}`), {
    params: Promise.resolve({ ws: door.slug }),
  }).then(json);

describe("business reads", () => {
  beforeEach(async () => {
    _resetDemoBusiness();
    _resetDemoEvents();
    door.denied = false;
    door.slug = `reads-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Denak", slug: door.slug });
    const storage = resolveDemoStorage(door.slug)!;
    await createRecordType(storage, {
      key: "account",
      label: "Account",
      fields: [{ key: "plan", label: "Plan", type: "select", options: ["starter", "pro"] }],
    }, null);
    const account = (await getRecordType(storage, "account"))!;
    for (const id of ["a1", "a2", "a3"]) {
      await upsertNodeRecord(storage, account, {
        external_id: id,
        title: `Account ${id}`,
        fields: { plan: "pro" },
      });
    }
  });

  it("lists a type's records with their fields, and says when it cut the list", async () => {
    const all = await listRecords("account");
    expect(all.status).toBe(200);
    expect(all.body.records).toHaveLength(3);
    expect(all.body.records[0].data.fields).toEqual({ plan: "pro" });
    expect(all.body.truncated).toBe(false);
    const two = await listRecords("account", "?limit=2");
    expect(two.body.records).toHaveLength(2);
    expect(two.body.truncated).toBe(true);
  });

  it("names an unknown type, and goes through the workspace door", async () => {
    expect((await listRecords("deal")).status).toBe(404);
    door.denied = true;
    expect((await listRecords("account")).status).toBe(404);
  });

  it("reads one subject's events, newest first", async () => {
    const storage = resolveDemoStorage(door.slug)!;
    await insertEvents(storage, [
      { type: "subscription.started", occurred_at: "2026-09-01T00:00:00Z", idempotency_key: "e1", subject_type: "account", subject_id: "a1", amount: 100, currency: "EUR" },
      { type: "subscription.changed", occurred_at: "2026-10-01T00:00:00Z", idempotency_key: "e2", subject_type: "account", subject_id: "a1", amount: 150, currency: "EUR" },
      { type: "subscription.started", occurred_at: "2026-10-02T00:00:00Z", idempotency_key: "e3", subject_type: "account", subject_id: "a2", amount: 50, currency: "EUR" },
    ], null);
    const res = await listEvents("?subject_type=account&subject_id=a1");
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { idempotency_key: string }) => e.idempotency_key)).toEqual(["e2", "e1"]);
    expect(res.body.events[0]).toMatchObject({ type: "subscription.changed", amount: 150, currency: "EUR", subject_id: "a1" });
    expect((await listEvents("?subject_type=account&subject_id=a1&limit=1")).body.events).toHaveLength(1);
  });

  it("needs a subject: the workspace-wide stream is not a page's to read", async () => {
    expect((await listEvents("")).status).toBe(400);
    expect((await listEvents("?subject_id=a1")).status).toBe(400);
  });
});
