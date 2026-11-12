/**
 * POST /api/workspaces/:ws/events — append business events: one event, or
 * `{ events: [...] }` (at most 1.000).
 *
 * Ingest API: ingest keys only (`openIngestWorkspace`). Each event is
 * validated with the contract's `BusinessEventInputSchema` (canonical types
 * strictly, others on shape); a retry with an `idempotency_key` already
 * stored answers `duplicate` and stores nothing. Valid events are stored even
 * when others in the batch are invalid — each slot says which. A stored
 * event schedules the workspace's rollup (debounced). Vocabulary and
 * examples: docs/ingest-api.md.
 *
 * GET /api/workspaces/:ws/events?subject_type=&subject_id=&limit= — one
 * subject's events, newest first (`SubjectEventsResponse`): a record's 360
 * page draws its timeline and MRR history from them. The read verb through
 * `openWorkspace`, so a member or a `bctx_live_` token reads it and an
 * ingest key — which only POSTs — cannot.
 */
import {
  BusinessEventInputSchema,
  EVENT_LIMITS,
  type BusinessEventInput,
  type EventIngestResult,
  type EventsIngestResponse,
  SUBJECT_EVENTS_MAX,
  type SubjectEventsResponse,
} from "@bcontext-dev/contract/business/events";
import { openIngestWorkspace, openWorkspace } from "@/lib/auth/workspace";
import { insertEvents, listSubjectEvents } from "@/lib/business/events";
import { businessErrorResponse } from "@/lib/business/http";
import { enqueueBusinessRollup } from "@/lib/business/rollup-job";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

/** 1.000 events with small properties. */
const MAX_BODY_BYTES = 2_000_000;

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openIngestWorkspace(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const raw = body.data as { events?: unknown };
  const batch = raw && typeof raw === "object" && Array.isArray(raw.events) ? raw.events : [body.data];
  if (batch.length === 0 || batch.length > EVENT_LIMITS.maxBatch) {
    return Response.json(
      { error: "invalid_request", message: `send 1 to ${EVENT_LIMITS.maxBatch} events per request` },
      { status: 400 },
    );
  }

  const results: EventIngestResult[] = [];
  const valid: Array<{ index: number; event: BusinessEventInput }> = [];
  batch.forEach((item, index) => {
    const parsed = BusinessEventInputSchema.safeParse(item);
    if (parsed.success) {
      valid.push({ index, event: parsed.data });
      results[index] = { index, idempotency_key: parsed.data.idempotency_key, status: "stored" };
    } else {
      const key = item && typeof item === "object" ? (item as { idempotency_key?: unknown }).idempotency_key : undefined;
      results[index] = {
        index,
        idempotency_key: typeof key === "string" ? key : null,
        status: "invalid",
        error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`).join("; "),
      };
    }
  });

  try {
    const inserted = await insertEvents(ctx.storage, valid.map((entry) => entry.event), ctx.keyId);
    inserted.forEach((outcome, position) => {
      const slot = results[valid[position]!.index]!;
      slot.status = outcome.status;
      if (outcome.id) slot.id = outcome.id;
    });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }

  const stored = results.filter((result) => result.status === "stored").length;
  if (stored > 0) void enqueueBusinessRollup(ctx.storage.workspace.id);
  const response: EventsIngestResponse = {
    stored,
    duplicates: results.filter((result) => result.status === "duplicate").length,
    invalid: results.filter((result) => result.status === "invalid").length,
    results,
  };
  // One event that was invalid is a 422, so a sender posting single events
  // sees the failure in the status; a batch reports per slot with 200.
  const single = !Array.isArray(raw?.events);
  return Response.json(response, { status: single && response.invalid === 1 ? 422 : 200 });
});

const SUBJECT_KEY = /^[a-z][a-z0-9_]{1,39}$/;

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const subjectType = url.searchParams.get("subject_type")?.trim() ?? "";
  const subjectId = url.searchParams.get("subject_id")?.trim() ?? "";
  // One subject at a time, on purpose: the workspace-wide stream is the
  // rollup's input, not something a page should page through.
  if (!SUBJECT_KEY.test(subjectType) || !subjectId || subjectId.length > EVENT_LIMITS.maxIdLength) {
    return Response.json(
      { error: "invalid_request", message: "subject_type (a record type key) and subject_id are required" },
      { status: 400 },
    );
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.max(1, Math.min(SUBJECT_EVENTS_MAX, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100));
  try {
    const body: SubjectEventsResponse = { events: await listSubjectEvents(ctx.storage, subjectType, subjectId, limit) };
    return Response.json(body);
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
