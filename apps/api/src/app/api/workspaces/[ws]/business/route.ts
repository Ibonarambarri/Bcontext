/**
 * The workspace's business settings.
 *
 *   GET   /api/workspaces/:ws/business   → { business_model, currency }      (read)
 *   PATCH /api/workspaces/:ws/business   { business_model?, currency? }       (admin)
 *
 * `business_model` decides which KPI set the metrics summary computes;
 * `currency` is the one money metrics are reported in (no FX). Same write as
 * `admin_write(op=set_business)` over MCP.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { getBusinessSettings, setBusinessSettings } from "@/lib/business/record-types";
import { enqueueBusinessRollup } from "@/lib/business/rollup-job";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

type Params = { params: Promise<{ ws: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  return Response.json(await getBusinessSettings(ctx.storage));
});

export const PATCH = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  try {
    const settings = await setBusinessSettings(ctx.storage, body.data);
    // The currency and the revenue definition feed the rollup.
    void enqueueBusinessRollup(ctx.storage.workspace.id);
    return Response.json(settings);
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
