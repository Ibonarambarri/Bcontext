/**
 * Group: /api/webhooks — the outbound webhook endpoints and their delivery
 * log. Without Supabase most authorised paths end in the same 500 both ways;
 * that is still parity, and the validation paths before the database are
 * exercised fully.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import { assertParity, type ParityRequest } from "./harness";
import * as deliveries from "@/app/api/webhooks/deliveries/route";
import * as deliveryRetryRoute from "@/app/api/webhooks/deliveries/[id]/retry/route";
import * as endpoints from "@/app/api/webhooks/endpoints/route";
import * as endpointRoute from "@/app/api/webhooks/endpoints/[id]/route";

/**
 * The `:id` modules type `ctx.params` as `Promise<{ id: string }>`, narrower
 * than the `Record<string, string>` a router can promise. The route table
 * makes the same cast; here it is made once per module instead of per call.
 */
const asModule = (m: unknown): RouteModule => m as RouteModule;
const deliveryRetry = asModule(deliveryRetryRoute);
const endpoint = asModule(endpointRoute);

const app = createApiApp({
  serve: ["/api/webhooks"],
});

/** Seeded demo workspace (`bcontext`) — the slug and the fixed id it carries. */
const DEMO_WS = "bcontext";
const DEMO_WS_ID = "00000000-0000-0000-0000-000000000010";
const UNKNOWN_UUID = "11111111-2222-4333-8444-555555555555";

/**
 * Parity, then the status the test names. Two calls that both hit a 429 or a
 * 500 agree perfectly and would otherwise pass as the path they claim to
 * exercise; pinned only where the answer is decided before the database.
 */
async function parityAt(status: number, module: RouteModule, r: ParityRequest): Promise<void> {
  const direct = await assertParity(app, module, r);
  expect(direct.status, `${r.method} ${r.path}`).toBe(status);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("parity: webhook management", () => {
  it("GET /api/webhooks/deliveries (no workspace)", () =>
    parityAt(400, deliveries, { method: "GET", path: "/api/webhooks/deliveries" }));
  it("GET /api/webhooks/deliveries (demo workspace)", () =>
    parityAt(200, deliveries, { method: "GET", path: `/api/webhooks/deliveries?workspace=${DEMO_WS}&status=dead` }));

  it("POST /api/webhooks/deliveries/:id/retry", () =>
    parityAt(403, deliveryRetry, {
      method: "POST",
      path: `/api/webhooks/deliveries/${UNKNOWN_UUID}/retry`,
      params: { id: UNKNOWN_UUID },
    }));

  it("GET /api/webhooks/endpoints (no workspace_id)", () =>
    parityAt(400, endpoints, { method: "GET", path: "/api/webhooks/endpoints" }));
  it("GET /api/webhooks/endpoints (workspace_id)", () =>
    assertParity(app, endpoints, { method: "GET", path: `/api/webhooks/endpoints?workspace_id=${DEMO_WS_ID}` }));
  it("POST /api/webhooks/endpoints (not JSON)", () =>
    parityAt(400, endpoints, { method: "POST", path: "/api/webhooks/endpoints", body: "not json" }));
  it("POST /api/webhooks/endpoints (invalid body)", () =>
    parityAt(400, endpoints, { method: "POST", path: "/api/webhooks/endpoints", body: { url: "nope" } }));
  it("POST /api/webhooks/endpoints (valid body)", () =>
    assertParity(app, endpoints, {
      method: "POST",
      path: "/api/webhooks/endpoints",
      body: { workspace_id: DEMO_WS_ID, url: "https://hooks.example.com/in", event_types: ["node.created"] },
    }));

  // The id is validated as a uuid before anything else, so the non-uuid case
  // proves the param itself arrived through Hono unchanged.
  it("DELETE /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, { method: "DELETE", path: "/api/webhooks/endpoints/not-a-uuid", params: { id: "not-a-uuid" } }));
  it("PATCH /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, {
      method: "PATCH",
      path: "/api/webhooks/endpoints/not-a-uuid",
      params: { id: "not-a-uuid" },
      body: { paused: true },
    }));
  it("POST /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, { method: "POST", path: "/api/webhooks/endpoints/not-a-uuid", params: { id: "not-a-uuid" } }));
  it("DELETE /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, { method: "DELETE", path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`, params: { id: UNKNOWN_UUID } }));
  it("PATCH /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, {
      method: "PATCH",
      path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`,
      params: { id: UNKNOWN_UUID },
      body: { paused: true },
    }));
  it("POST /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, { method: "POST", path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`, params: { id: UNKNOWN_UUID } }));
  it("PATCH /api/webhooks/endpoints/:id (invalid body)", () =>
    parityAt(400, endpoint, {
      method: "PATCH",
      path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`,
      params: { id: UNKNOWN_UUID },
      body: { paused: "yes" },
    }));
});
