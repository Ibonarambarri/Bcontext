/**
 * GET /api/workspaces/:ws/timeline?subject_id=…[&subject_type=…][&limit=50]
 * — one subject's business events, newest first: what the account 360 page
 * shows under "what happened with this customer". Shape:
 * `BusinessTimelineResponse` (contract `business/timeline.ts`).
 *
 * `subject_id` is the id the app sends events with (a record's
 * `external_id`, a dataset row key), never a node id. A supplier's timeline
 * also lists the bookings that name it in `properties.supplier_id`.
 *
 * Read verb, like the metrics summary: whoever can read the workspace can
 * read what happened in it. Events are facts — there is no write here; they
 * arrive through the ingest API.
 */
import { TIMELINE_LIMITS, type BusinessTimelineResponse } from "@bcontext-dev/contract/business/timeline";
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { readSubjectTimeline } from "@/lib/business/event-reads";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const url = new URL(req.url);
  const subjectId = url.searchParams.get("subject_id")?.trim();
  if (!subjectId || subjectId.length > 200) {
    return Response.json({ error: "invalid_request", message: "subject_id is required (the id your app sends events with, ≤ 200 chars)" }, { status: 400 });
  }
  const subjectType = url.searchParams.get("subject_type")?.trim() || null;
  if (subjectType && !/^[a-z][a-z0-9_]{1,39}$/.test(subjectType)) {
    return Response.json({ error: "invalid_request", message: "subject_type must be a record type key" }, { status: 400 });
  }
  const limit = Math.min(Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || TIMELINE_LIMITS.defaultLimit), TIMELINE_LIMITS.maxLimit);
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  try {
    const { events, more } = await readSubjectTimeline(ctx.storage, { type: subjectType, id: subjectId }, limit);
    const body: BusinessTimelineResponse = { subject_type: subjectType, subject_id: subjectId, events, more };
    return Response.json(body);
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
