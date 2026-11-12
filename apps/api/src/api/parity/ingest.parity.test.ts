/**
 * Group: /api/ingest, /api/meetings.
 *
 * The ingest routes address the workspace by UUID and fall back to the demo
 * store, so they exercise a real body, a real param and a real row through
 * both paths. The meetings routes need Supabase and stop at the gate, which
 * still walks them through matching, params, method dispatch and Response
 * passthrough — all a parity test can and needs to claim.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import { assertParity } from "./harness";
import * as candidates from "@/app/api/ingest/candidates/route";
import * as candidateRoute from "@/app/api/ingest/candidates/[id]/route";
import * as candidateAcceptRoute from "@/app/api/ingest/candidates/[id]/accept/route";
import * as candidateDismissRoute from "@/app/api/ingest/candidates/[id]/dismiss/route";
import * as ingestStats from "@/app/api/ingest/stats/route";
import * as attachTranscriptRoute from "@/app/api/meetings/attach-transcript/[nodeId]/route";
import * as refineRoute from "@/app/api/meetings/refine/[nodeId]/route";

// Dynamic routes type their params (`{ id: string }`), which `RouteModule`'s
// `Record<string, string>` does not satisfy structurally; the generated table
// casts them the same way.
const candidate = candidateRoute as unknown as RouteModule;
const candidateAccept = candidateAcceptRoute as unknown as RouteModule;
const candidateDismiss = candidateDismissRoute as unknown as RouteModule;
const attachTranscript = attachTranscriptRoute as unknown as RouteModule;
const refine = refineRoute as unknown as RouteModule;

const app = createApiApp({
  serve: ["/api/ingest", "/api/meetings"],
});

/** The seeded demo workspace (WS_CONTEXT); the only one with ingest candidates. */
const DEMO_WS = "00000000-0000-0000-0000-000000000010";
/** Seeded pending candidates, see `src/lib/ingest/demo-candidates.ts`. */
const DEMO_CANDIDATE = "00000000-0000-0000-000c-000000000001";
const DEMO_CANDIDATE_2 = "00000000-0000-0000-000c-000000000002";
/** Well-formed, resolves to nothing anywhere. */
const UNKNOWN = "11111111-1111-4111-8111-111111111111";

describe("parity: ingest", () => {
  // A status change stamps `reviewed_at` with the wall clock, and the two
  // calls are milliseconds apart. Freezing Date (only Date) makes the two
  // rows identical without teaching the harness about this one field.
  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterAll(() => vi.useRealTimers());

  it("GET /api/ingest/candidates", async () => {
    await assertParity(app, candidates, { method: "GET", path: `/api/ingest/candidates?workspace_id=${DEMO_WS}` });
    await assertParity(app, candidates, { method: "GET", path: `/api/ingest/candidates?workspace_id=${DEMO_WS}&status=pending` });
    await assertParity(app, candidates, { method: "GET", path: `/api/ingest/candidates?workspace_id=${UNKNOWN}` });
    await assertParity(app, candidates, { method: "GET", path: `/api/ingest/candidates?workspace_id=${DEMO_WS}&status=archived` });
  });

  it("PATCH /api/ingest/candidates/:id", async () => {
    // Not `accepted`: that transition is terminal, so the second call would
    // see a different row than the first.
    await assertParity(app, candidate, {
      method: "PATCH",
      path: `/api/ingest/candidates/${DEMO_CANDIDATE}`,
      params: { id: DEMO_CANDIDATE },
      body: { workspace_id: DEMO_WS, status: "reprocess", feedback: "split it" },
    });
    await assertParity(app, candidate, {
      method: "PATCH",
      path: `/api/ingest/candidates/${DEMO_CANDIDATE_2}`,
      params: { id: DEMO_CANDIDATE_2 },
      body: { workspace_id: DEMO_WS, status: "dismissed" },
    });
    await assertParity(app, candidate, {
      method: "PATCH",
      path: `/api/ingest/candidates/${UNKNOWN}`,
      params: { id: UNKNOWN },
      body: { workspace_id: DEMO_WS, status: "pending" },
    });
    await assertParity(app, candidate, {
      method: "PATCH",
      path: `/api/ingest/candidates/${DEMO_CANDIDATE}`,
      params: { id: DEMO_CANDIDATE },
      body: { workspace_id: DEMO_WS, status: "archived" },
    });
    await assertParity(app, candidate, { method: "PATCH", path: `/api/ingest/candidates/${DEMO_CANDIDATE}`, params: { id: DEMO_CANDIDATE }, body: "{not json" });
  });

  it("POST /api/ingest/candidates/:id/accept", async () => {
    await assertParity(app, candidateAccept, {
      method: "POST",
      path: `/api/ingest/candidates/${DEMO_CANDIDATE}/accept`,
      params: { id: DEMO_CANDIDATE },
      body: { workspace_id: DEMO_WS },
    });
    await assertParity(app, candidateAccept, {
      method: "POST",
      path: `/api/ingest/candidates/${UNKNOWN}/accept`,
      params: { id: UNKNOWN },
      body: { workspace_id: UNKNOWN },
    });
    await assertParity(app, candidateAccept, { method: "POST", path: `/api/ingest/candidates/${DEMO_CANDIDATE}/accept`, params: { id: DEMO_CANDIDATE }, body: {} });
  });

  it("POST /api/ingest/candidates/:id/dismiss", async () => {
    await assertParity(app, candidateDismiss, {
      method: "POST",
      path: `/api/ingest/candidates/${DEMO_CANDIDATE}/dismiss`,
      params: { id: DEMO_CANDIDATE },
      body: { workspace_id: DEMO_WS },
    });
    await assertParity(app, candidateDismiss, {
      method: "POST",
      path: `/api/ingest/candidates/${UNKNOWN}/dismiss`,
      params: { id: UNKNOWN },
      body: { workspace_id: UNKNOWN },
    });
    await assertParity(app, candidateDismiss, { method: "POST", path: `/api/ingest/candidates/${DEMO_CANDIDATE}/dismiss`, params: { id: DEMO_CANDIDATE }, body: {} });
  });

  it("GET /api/ingest/stats", async () => {
    await assertParity(app, ingestStats, { method: "GET", path: `/api/ingest/stats?workspace_id=${DEMO_WS}` });
    await assertParity(app, ingestStats, { method: "GET", path: `/api/ingest/stats?workspace_id=${UNKNOWN}` });
    await assertParity(app, ingestStats, { method: "GET", path: "/api/ingest/stats" });
  });
});

describe("parity: meetings", () => {
  const transcript = "Weekly sync. Decided to keep HNSW; revisit IVFFlat only past five million rows. Owner: infra.";

  it("POST /api/meetings/attach-transcript/:nodeId", async () => {
    await assertParity(app, attachTranscript, {
      method: "POST",
      path: `/api/meetings/attach-transcript/${UNKNOWN}`,
      params: { nodeId: UNKNOWN },
      body: { transcript, participants: ["ana"], durationSec: 1800 },
    });
    await assertParity(app, attachTranscript, {
      method: "POST",
      path: `/api/meetings/attach-transcript/${UNKNOWN}`,
      params: { nodeId: UNKNOWN },
      body: { transcript: "too short" },
    });
  });

  it("POST /api/meetings/refine/:nodeId", async () => {
    await assertParity(app, refine, { method: "POST", path: `/api/meetings/refine/${UNKNOWN}`, params: { nodeId: UNKNOWN } });
    await assertParity(app, refine, { method: "POST", path: "/api/meetings/refine/not-a-node", params: { nodeId: "not-a-node" } });
  });
});
