/**
 * POST /api/views/:id/resolve?workspace=… — run a saved view and return what
 * its renderer needs: the matching node ids plus, per renderer, the board's
 * blocker badges, the graph snapshot or the roadmap rows. The web calls it on every view open;
 * MCP has `views(op=resolve)`.
 *
 * Views over record types also get their business payload
 * (`buildBusinessExtras`): the records with their fields, a dataset type's
 * rows, a metrics summary and chart aggregates, or a heatmap's aggregate.
 *
 * Reads go through the scoped storage `resolveViewRequest` opened, so a
 * narrowed principal resolves against its own reach, never the whole index.
 * A query over the cost budget is 422 rather than a slow answer.
 */
import { withRoute } from "@/lib/route";
import { getView } from "@/lib/views/store";
import { resolveViewQuery, ViewQueryCostError } from "@/lib/views/resolver";
import { resolveViewRequest, viewErrorResponse } from "@/lib/views/http";
import { buildBoardBlockers } from "@bcontext-dev/contract/board/model";
import { buildGraphViewSnapshot } from "@/lib/graph/view-snapshot";
import { buildRoadmapPayload } from "@/lib/views/roadmap";
import { buildBusinessExtras, readViewRecords } from "@/lib/views/business-payload";

export const POST = withRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspace) return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  const resolved = await resolveViewRequest(req, workspace, "nodes:read");
  if ("response" in resolved) return resolved.response;
  try {
    const view = await getView(resolved.storage, resolved.principal, (await params).id);
    const renderer = view.presentation.renderer;
    // One bounded read per request: the summary index (no content_md, no
    // arbitrary data — blocker badges and graph nodes only need summary
    // fields) and, when the renderer needs them, the durable edges. The
    // resolver and the renderer payloads below all share these two reads.
    const needsEdges = renderer === "board" || renderer === "graph" || renderer === "roadmap"
      || Boolean(view.query.traversal);
    // Record kinds are read in full once: their fields feed both the field
    // filters and the records payload.
    const [index, edges, records] = await Promise.all([
      resolved.storage.listNodeSummaries({ limit: 5_000 }),
      needsEdges ? resolved.storage.listEdges() : Promise.resolve([]),
      readViewRecords(resolved.storage, view),
    ]);
    const result = await resolveViewQuery(resolved.storage, view.query, {
      nodes: index,
      edges: needsEdges ? edges : undefined,
      recordFields: records?.fields,
    });
    const board = renderer === "board"
      ? buildBoardBlockers(index, edges, result.node_ids)
      : undefined;
    const graph = renderer === "graph"
      ? await buildGraphViewSnapshot(resolved.storage, view, result, { nodes: index, edges })
      : undefined;
    const roadmap = renderer === "roadmap"
      ? await buildRoadmapPayload(resolved.storage, view, result.node_ids, index, edges)
      : undefined;
    const business = await buildBusinessExtras(resolved.storage, view, result, records?.nodes);
    return Response.json({
      view,
      result,
      ...(board ? { board: { blockers: board } } : {}),
      ...(graph ? { graph } : {}),
      ...(roadmap ? { roadmap } : {}),
      ...business,
    });
  } catch (error) {
    const response = viewErrorResponse(error); if (response) return response;
    if (error instanceof ViewQueryCostError) return Response.json({ error: "query_cost_exceeded", message: error.message }, { status: 422 });
    throw error;
  }
});
