/**
 * GET /api/workspaces/:ws/metrics/summary?period=month — the KPI set of the
 * workspace's business model in one read: per KPI the current month, the
 * previous one, the delta, the same month last year and a 12-month series.
 * What the dashboard draws; MCP reaches the same data with `data(op=metrics)`.
 *
 * Read verb: anyone who can read the workspace can read its numbers. Shape:
 * `MetricsSummary` in the contract (business/metrics.ts).
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { getMetricsSummary } from "@/lib/business/summary";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const period = new URL(req.url).searchParams.get("period") ?? "month";
  if (period !== "month") {
    return Response.json({ error: "invalid_request", message: "period must be `month` (the only one so far)" }, { status: 400 });
  }
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(await getMetricsSummary(ctx.storage));
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
