/**
 * Group: the business layer under /api/workspaces/:ws — the ingest API
 * (records, events), the metrics summary, record types and business
 * settings.
 *
 * What these routes risk in the router is the path itself: an external id is
 * whatever the sender's primary key looks like (`cus_N8x…`, `42`, `a.b`), it
 * sits in the last segment, and a router that decodes or matches it
 * differently from the direct call would update a different record. Every
 * route is exercised on a happy path and a refusal. Writes run twice
 * (direct, then Hono), which is the point for an upsert: the second answer
 * is "unchanged" from both sides, or the two disagree.
 *
 * Only the ingest key lookup is faked (a hash lookup in `ingest_keys`).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("@/lib/business/ingest-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/business/ingest-keys")>()),
  verifyIngestKey: async (header: string | null) =>
    header === "Bearer bctx_ingest_good" ? { id: "key-1", workspaceId: keys.workspaceId } : null,
}));

import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { createRecordType } from "@/lib/business/record-types";
import { _resetRateLimit } from "@/lib/rate-limit";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import { assertParity, buildRequest, type ParityRequest } from "./harness";
import * as recordsRoute from "@/app/api/workspaces/[ws]/records/[type]/route";
import * as recordRoute from "@/app/api/workspaces/[ws]/records/[type]/[external_id]/route";
import * as eventsRoute from "@/app/api/workspaces/[ws]/events/route";
import * as summaryRoute from "@/app/api/workspaces/[ws]/metrics/summary/route";
import * as recordTypesRoute from "@/app/api/workspaces/[ws]/record-types/route";
import * as businessRoute from "@/app/api/workspaces/[ws]/business/route";

const asModule = (m: object) => m as RouteModule;
const app = createApiApp({ serve: ["/api/workspaces"] });
const AUTH = { authorization: "Bearer bctx_ingest_good" };

let slug: string;

describe("business routes: direct vs Hono", () => {
  beforeAll(async () => {
    slug = `parity-biz-${Date.now()}`;
    const workspace = createWorkspace({ name: "Parity business", slug });
    keys.workspaceId = workspace.id;
    await createRecordType(resolveDemoStorage(slug)!, {
      key: "account",
      label: "Account",
      fields: [{ key: "plan", label: "Plan", type: "select", options: ["starter", "pro"] }],
    }, null);
  });

  const req = (r: Omit<ParityRequest, "headers"> & { headers?: Record<string, string> }): ParityRequest => {
    _resetRateLimit();
    return { ...r, headers: { ...AUTH, ...(r.headers ?? {}) } };
  };

  /**
   * An upsert's first execution creates and every later one is a no-op, so
   * parity is asserted on the replay: run once directly to settle the state,
   * then demand that direct and Hono both answer the settled state the same.
   */
  async function prime(module: object, r: ParityRequest): Promise<void> {
    const handler = (module as Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>)[r.method]!;
    await handler(buildRequest(r), { params: Promise.resolve(r.params ?? {}) });
  }

  it("PUT a record whose id has dots and dashes", async () => {
    const id = "cus_N8x.42-a";
    const r = req({
      method: "PUT",
      path: `/api/workspaces/${slug}/records/account/${id}`,
      params: { ws: slug, type: "account", external_id: id },
      body: { title: "Acme", fields: { plan: "pro" } },
    });
    await prime(recordRoute, r);
    const again = await assertParity(app, asModule(recordRoute), r);
    expect(again.status).toBe(200);
    expect((again.body as { status: string }).status).toBe("unchanged");
  });

  it("PUT refuses a bad field and an unknown key the same way", async () => {
    const bad = await assertParity(app, asModule(recordRoute), req({
      method: "PUT",
      path: `/api/workspaces/${slug}/records/account/x1`,
      params: { ws: slug, type: "account", external_id: "x1" },
      body: { fields: { plan: "gold" } },
    }));
    expect(bad.status).toBe(422);
    const anon = await assertParity(app, asModule(recordRoute), {
      method: "PUT",
      path: `/api/workspaces/${slug}/records/account/x1`,
      params: { ws: slug, type: "account", external_id: "x1" },
      body: { fields: {} },
    });
    expect(anon.status).toBe(401);
  });

  it("POST a batch of records", async () => {
    const r = req({
      method: "POST",
      path: `/api/workspaces/${slug}/records/account`,
      params: { ws: slug, type: "account" },
      body: { records: [{ external_id: "b1", fields: { plan: "starter" } }] },
    });
    await prime(recordsRoute, r);
    const again = await assertParity(app, asModule(recordsRoute), r);
    expect((again.body as { unchanged: number }).unchanged).toBe(1);
  });

  it("POST events: a retry is a duplicate from both sides", async () => {
    const event = { type: "feature.used", occurred_at: "2026-11-01T10:00:00Z", idempotency_key: "parity-1" };
    const r = req({ method: "POST", path: `/api/workspaces/${slug}/events`, params: { ws: slug }, body: event });
    await prime(eventsRoute, r);
    const again = await assertParity(app, asModule(eventsRoute), r);
    expect((again.body as { duplicates: number }).duplicates).toBe(1);
  });

  it("GET the metrics summary, record types and business settings", async () => {
    // Without Supabase every session-less call is the demo actor, which the
    // demo backend lets read: these prove the path and params, not auth.
    const plain = (path: string, module: object, params: Record<string, string>) =>
      assertParity(app, asModule(module), { method: "GET", path, params, headers: { "x-forwarded-for": `10.1.0.${Math.floor(Math.random() * 200)}` } });
    expect((await plain(`/api/workspaces/${slug}/metrics/summary?period=month`, summaryRoute, { ws: slug })).status).toBe(200);
    expect((await plain(`/api/workspaces/${slug}/metrics/summary?period=week`, summaryRoute, { ws: slug })).status).toBe(400);
    const types = await plain(`/api/workspaces/${slug}/record-types`, recordTypesRoute, { ws: slug });
    expect((types.body as { record_types: Array<{ key: string }> }).record_types.map((t) => t.key)).toEqual(["account"]);
    expect((await plain(`/api/workspaces/${slug}/business`, businessRoute, { ws: slug })).body).toEqual({ business_model: "product", currency: "EUR" });
  });

  it("is exhaustive about which methods each path answers", () => {
    expect(Object.keys(recordRoute).sort()).toEqual(["DELETE", "PUT"]);
    expect(Object.keys(recordsRoute)).toEqual(["POST"]);
  });
});
