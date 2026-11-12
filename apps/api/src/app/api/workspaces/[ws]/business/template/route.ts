/**
 * The business template of a workspace: the record types and views a b2b,
 * b2c or marketplace workspace starts with.
 *
 *   GET  /api/workspaces/:ws/business/template[?business_model=…]
 *        → what applying would create and skip, without writing (read)
 *   POST /api/workspaces/:ws/business/template  { business_model? }  ({} for the workspace's own)
 *        → apply it (admin); `business_model` defaults to the workspace's own
 *
 * Applying is additive and idempotent (`applyBusinessTemplate`): existing
 * record type keys and template views are skipped, nothing is overwritten or
 * deleted, so it is safe to run again after people renamed and edited
 * things. Same as `admin_write(op=apply_business_template)` over MCP.
 */
import { z } from "zod";
import { BUSINESS_MODELS, type BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { planBusinessTemplate } from "@bcontext-dev/contract/business/templates";
import { openWorkspace } from "@/lib/auth/workspace";
import { businessErrorResponse } from "@/lib/business/http";
import { getBusinessSettings, listRecordTypes } from "@/lib/business/record-types";
import { applyBusinessTemplate } from "@/lib/business/templates";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { viewPrincipal } from "@/lib/views/access";
import { listViews } from "@/lib/views/store";

type Params = { params: Promise<{ ws: string }> };

const Body = z.object({ business_model: z.enum(BUSINESS_MODELS).optional() }).strict();

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const requested = new URL(req.url).searchParams.get("business_model");
  const parsed = z.enum(BUSINESS_MODELS).optional().safeParse(requested ?? undefined);
  if (!parsed.success) return Response.json({ error: "invalid_request", message: `business_model must be one of ${BUSINESS_MODELS.join(", ")}` }, { status: 400 });
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const principal = await viewPrincipal(ctx.actor, ctx.storage);
  const model: BusinessModel = parsed.data ?? (await getBusinessSettings(ctx.storage)).business_model;
  const [types, views] = await Promise.all([listRecordTypes(ctx.storage), listViews(ctx.storage, principal)]);
  return Response.json(planBusinessTemplate(model, { record_type_keys: types.map((type) => type.key), views }));
});

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: "invalid_request", message: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  try {
    const principal = await viewPrincipal(ctx.actor, ctx.storage);
    const model = parsed.data.business_model ?? (await getBusinessSettings(ctx.storage)).business_model;
    const createdBy = ctx.actor.kind === "user" || ctx.actor.kind === "agent_user" ? ctx.actor.userId : null;
    const result = await applyBusinessTemplate(ctx.storage, principal, model, createdBy);
    const createdAny = result.created.record_types.length + result.created.views.length > 0;
    return Response.json(result, { status: createdAny ? 201 : 200 });
  } catch (err) {
    const mapped = businessErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
