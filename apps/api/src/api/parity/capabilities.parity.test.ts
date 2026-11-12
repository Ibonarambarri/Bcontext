/**
 * Group: /api/capabilities*, /api/capability-grants, /api/capability-bundles.
 * (Ingest and meetings have their own group in ingest.parity.test.ts.)
 *
 * Two things are at stake here. First, `/api/capabilities` has literal
 * children (`discover`, `oauth/*`, `provider-logo`) beside `:id` and
 * `:id/review`; a router that fills the param first would hand
 * `provider-logo` to the `:id` handler, which happens to answer 400 as well —
 * so the invalid requests below are chosen where the two handlers' messages
 * differ, and parity on the message is what proves the literal won.
 *
 * Everything else needs Supabase and stops at the admin gate (500 here, 401 in
 * production) or at the demo actor (403). That still walks the route through
 * matching, params, method dispatch and Response passthrough, which is all a
 * parity test can and needs to claim.
 */
import { describe, it } from "vitest";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import { assertParity } from "./harness";
import * as capabilities from "@/app/api/capabilities/route";
import * as discover from "@/app/api/capabilities/discover/route";
import * as oauthCallback from "@/app/api/capabilities/oauth/callback/route";
import * as oauthStart from "@/app/api/capabilities/oauth/start/route";
import * as oauthStatus from "@/app/api/capabilities/oauth/status/route";
import * as providerLogo from "@/app/api/capabilities/provider-logo/route";
import * as capabilityRoute from "@/app/api/capabilities/[id]/route";
import * as capabilityReviewRoute from "@/app/api/capabilities/[id]/review/route";
import * as bundles from "@/app/api/capability-bundles/route";
import * as grants from "@/app/api/capability-grants/route";
import * as grantRoute from "@/app/api/capability-grants/[id]/route";

// Dynamic routes type their params (`{ id: string }`), which `RouteModule`'s
// `Record<string, string>` does not satisfy structurally; the generated table
// casts them the same way.
const capability = capabilityRoute as unknown as RouteModule;
const capabilityReview = capabilityReviewRoute as unknown as RouteModule;
const grant = grantRoute as unknown as RouteModule;

const app = createApiApp({
  serve: ["/api/capabilities", "/api/capability-grants", "/api/capability-bundles"],
});

/** Well-formed, resolves to nothing anywhere. */
const UNKNOWN = "11111111-1111-4111-8111-111111111111";

const webhookContract = {
  protocol: "webhook",
  tool: { name: "ping", description: "", inputSchema: { type: "object" } },
};

describe("parity: capabilities catalog", () => {
  it("GET /api/capabilities", async () => {
    await assertParity(app, capabilities, { method: "GET", path: `/api/capabilities?workspace_id=${UNKNOWN}&surface=providers` });
    await assertParity(app, capabilities, { method: "GET", path: "/api/capabilities?workspace_id=nope" });
  });

  it("POST /api/capabilities", async () => {
    await assertParity(app, capabilities, {
      method: "POST",
      path: "/api/capabilities",
      body: { workspace_id: UNKNOWN, key: "notes", type: "skill", provider: "local", title: "Notes", contract: {} },
    });
    await assertParity(app, capabilities, { method: "POST", path: "/api/capabilities", body: { workspace_id: UNKNOWN } });
    await assertParity(app, capabilities, { method: "POST", path: "/api/capabilities", body: "{not json" });
  });

  it("PATCH /api/capabilities", async () => {
    await assertParity(app, capabilities, {
      method: "PATCH",
      path: "/api/capabilities",
      body: { workspace_id: UNKNOWN, id: UNKNOWN, status: "disabled" },
    });
    await assertParity(app, capabilities, {
      method: "PATCH",
      path: "/api/capabilities",
      body: { workspace_id: UNKNOWN, id: UNKNOWN, status: "published" },
    });
  });

  it("POST /api/capabilities/discover", async () => {
    // Valid input would open a connection to the endpoint; the admin gate
    // stops it first, which is what keeps this test off the network.
    await assertParity(app, discover, {
      method: "POST",
      path: "/api/capabilities/discover",
      body: { workspace_id: UNKNOWN, connection: { endpointUrl: "https://mcp.example.com/mcp", allowedHosts: ["mcp.example.com"] } },
    });
    await assertParity(app, discover, {
      method: "POST",
      path: "/api/capabilities/discover",
      body: { workspace_id: UNKNOWN, connection: { endpointUrl: "http://mcp.example.com/mcp", allowedHosts: ["mcp.example.com"] } },
    });
  });

  it("GET /api/capabilities/oauth/callback", async () => {
    await assertParity(app, oauthCallback, { method: "GET", path: `/api/capabilities/oauth/callback?state=${UNKNOWN}&code=abc` });
    await assertParity(app, oauthCallback, { method: "GET", path: "/api/capabilities/oauth/callback" });
  });

  it("POST /api/capabilities/oauth/start", async () => {
    await assertParity(app, oauthStart, {
      method: "POST",
      path: "/api/capabilities/oauth/start",
      body: { workspace_id: UNKNOWN, endpoint_url: "https://mcp.example.com/mcp", allowed_hosts: ["mcp.example.com"] },
    });
    await assertParity(app, oauthStart, {
      method: "POST",
      path: "/api/capabilities/oauth/start",
      body: { workspace_id: UNKNOWN, endpoint_url: "https://mcp.example.com/mcp", allowed_hosts: ["other.example.com"] },
    });
  });

  it("GET /api/capabilities/oauth/status", async () => {
    await assertParity(app, oauthStatus, { method: "GET", path: `/api/capabilities/oauth/status?workspace_id=${UNKNOWN}&attempt_id=${UNKNOWN}` });
    await assertParity(app, oauthStatus, { method: "GET", path: `/api/capabilities/oauth/status?workspace_id=${UNKNOWN}` });
  });

  it("DELETE /api/capabilities/oauth/status", async () => {
    await assertParity(app, oauthStatus, { method: "DELETE", path: `/api/capabilities/oauth/status?workspace_id=${UNKNOWN}&attempt_id=${UNKNOWN}` });
    await assertParity(app, oauthStatus, { method: "DELETE", path: "/api/capabilities/oauth/status?attempt_id=nope" });
  });

  it("GET /api/capabilities/provider-logo", async () => {
    await assertParity(app, providerLogo, { method: "GET", path: `/api/capabilities/provider-logo?workspace_id=${UNKNOWN}&capability_id=${UNKNOWN}` });
    // No query: this handler says "workspace_id and capability_id are
    // required"; the `:id` handler, had it won the match, says "valid
    // provider and workspace ids are required". Same status, different body.
    await assertParity(app, providerLogo, { method: "GET", path: "/api/capabilities/provider-logo" });
    await assertParity(app, providerLogo, { method: "GET", path: `/api/capabilities/provider-logo?workspace_id=${UNKNOWN}` });
  });

  it("GET /api/capabilities/:id", async () => {
    await assertParity(app, capability, { method: "GET", path: `/api/capabilities/${UNKNOWN}?workspace_id=${UNKNOWN}`, params: { id: UNKNOWN } });
    await assertParity(app, capability, { method: "GET", path: `/api/capabilities/not-a-uuid?workspace_id=${UNKNOWN}`, params: { id: "not-a-uuid" } });
  });

  it("PATCH /api/capabilities/:id", async () => {
    await assertParity(app, capability, {
      method: "PATCH",
      path: `/api/capabilities/${UNKNOWN}`,
      params: { id: UNKNOWN },
      body: {
        workspace_id: UNKNOWN,
        expected_updated_at: "2026-01-01T00:00:00.000Z",
        type: "api",
        provider: "example",
        title: "Example",
        contract: webhookContract,
        connection: { endpointUrl: "https://api.example.com/hook", authType: "none", credentialMode: "replace", allowedHosts: ["api.example.com"] },
      },
    });
    await assertParity(app, capability, { method: "PATCH", path: "/api/capabilities/not-a-uuid", params: { id: "not-a-uuid" }, body: {} });
  });

  it("DELETE /api/capabilities/:id", async () => {
    await assertParity(app, capability, { method: "DELETE", path: `/api/capabilities/${UNKNOWN}?workspace_id=${UNKNOWN}`, params: { id: UNKNOWN } });
    await assertParity(app, capability, {
      method: "DELETE",
      path: `/api/capabilities/${UNKNOWN}?workspace_id=${UNKNOWN}&expected_updated_at=yesterday`,
      params: { id: UNKNOWN },
    });
  });

  it("GET /api/capabilities/:id/review", async () => {
    await assertParity(app, capabilityReview, { method: "GET", path: `/api/capabilities/${UNKNOWN}/review?workspace_id=${UNKNOWN}`, params: { id: UNKNOWN } });
    await assertParity(app, capabilityReview, { method: "GET", path: `/api/capabilities/${UNKNOWN}/review`, params: { id: UNKNOWN } });
  });

  it("POST /api/capabilities/:id/review", async () => {
    await assertParity(app, capabilityReview, {
      method: "POST",
      path: `/api/capabilities/${UNKNOWN}/review`,
      params: { id: UNKNOWN },
      body: { workspace_id: UNKNOWN, decision: "approved", comment: "looks fine" },
    });
    await assertParity(app, capabilityReview, {
      method: "POST",
      path: `/api/capabilities/${UNKNOWN}/review`,
      params: { id: UNKNOWN },
      body: { workspace_id: UNKNOWN, decision: "maybe" },
    });
  });

  it("POST /api/capability-bundles", async () => {
    await assertParity(app, bundles, {
      method: "POST",
      path: "/api/capability-bundles",
      body: { workspace_id: UNKNOWN, key: "starter", title: "Starter", capability_version_ids: [UNKNOWN] },
    });
    await assertParity(app, bundles, {
      method: "POST",
      path: "/api/capability-bundles",
      body: { workspace_id: UNKNOWN, key: "Starter Pack", title: "Starter", capability_version_ids: [] },
    });
  });

  it("POST /api/capability-grants", async () => {
    await assertParity(app, grants, {
      method: "POST",
      path: "/api/capability-grants",
      body: {
        workspace_id: UNKNOWN,
        principal: { kind: "agent", source_type: "agent", source_id: "agent-1", display_name: "Agent" },
        capability_id: UNKNOWN,
      },
    });
    await assertParity(app, grants, {
      method: "POST",
      path: "/api/capability-grants",
      body: {
        workspace_id: UNKNOWN,
        principal: { kind: "agent", source_type: "agent", source_id: "agent-1", display_name: "Agent" },
        capability_id: UNKNOWN,
        bundle_id: UNKNOWN,
      },
    });
  });

  it("DELETE /api/capability-grants/:id", async () => {
    await assertParity(app, grant, { method: "DELETE", path: `/api/capability-grants/${UNKNOWN}?workspace_id=${UNKNOWN}`, params: { id: UNKNOWN } });
    await assertParity(app, grant, { method: "DELETE", path: `/api/capability-grants/${UNKNOWN}`, params: { id: UNKNOWN } });
    await assertParity(app, grant, { method: "DELETE", path: `/api/capability-grants/nope?workspace_id=${UNKNOWN}`, params: { id: "nope" } });
  });
});
