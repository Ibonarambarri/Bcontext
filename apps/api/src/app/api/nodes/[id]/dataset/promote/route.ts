/**
 * POST /api/nodes/:id/dataset/promote — turn one keyed row of a dataset into
 * a node record: the web's "Convert to node" on a Customers / Suppliers row,
 * and the REST twin of `data_write(op=promote_row)` over MCP.
 *
 *   { workspace, key, record_type, title?, mapping? }  →  201 { node, created: true }
 *                                                        200 { node, created: false }
 *
 * `:id` is the dataset (`data`) node; `record_type` a node record type of the
 * workspace. Promoting the same row again updates the node it made instead
 * of making a second one (`promoteDatasetRow` keeps `data.source_row`). Write
 * verb, through `openWorkspace`, so the caller's reach bounds both the
 * dataset read and the node write.
 */
import { z } from "zod";
import { changePayload } from "@bcontext-dev/contract/changes";
import { record as recordActivity } from "@/lib/activity";
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { promoteDatasetRow } from "@/lib/business/records";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z.object({
  workspace: z.string().min(1),
  key: z.string().min(1).max(200),
  record_type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  title: z.string().trim().min(1).max(500).optional(),
  mapping: z.record(z.string().min(1).max(63)).optional(),
}).strict();

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: "invalid_request", message: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const { workspace, ...input } = parsed.data;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const { id } = await params;
  try {
    const promoted = await promoteDatasetRow(storage, { node_id: id, ...input });
    const isAgent = actor.kind === "agent" || actor.kind === "agent_user";
    recordActivity(workspace, promoted.created ? "create" : "update", promoted.node.id, promoted.node.title, promoted.node.kind, {
      actorKind: isAgent ? "agent" : "human",
      actorId: actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null,
      principalId: isAgent ? actor.agentId : null,
      payload: changePayload({
        after: promoted.node,
        via: actor.kind === "user" ? "web" : "rest",
        extra: { promoted_from: { dataset_node_id: id, key: input.key } },
      }),
    });
    if (storage.backend === "supabase") {
      const by = actor.kind === "user" ? actor.userId : undefined;
      void (promoted.created
        ? wsBroadcast.nodeCreated(storage.workspace.id, promoted.node.id, by)
        : wsBroadcast.nodeUpdated(storage.workspace.id, promoted.node.id, by, { data: promoted.node.data, updated_at: promoted.node.updated_at }));
    }
    return Response.json({ node: promoted.node, created: promoted.created }, { status: promoted.created ? 201 : 200 });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
