/**
 * The caller's workspaces — the hub page and the "which slug am I" question
 * an agent asks first (MCP has `list_workspaces`).
 *
 *   GET  /api/workspaces[?stats=1]   what `gate` lets this principal see
 *   POST /api/workspaces             { name, description?, business_model? } → 201 { workspace, business_template? }
 *
 * `gate` accepts a session or a bearer token; creating needs a session and
 * is delegated to `createWorkspaceForUser`, which applies the instance's
 * `WORKSPACE_CREATION` policy (403 `workspace_creation_restricted`). Without
 * Supabase both read from the in-memory demo store.
 */
import { z } from "zod";
import { record as recordActivity } from "@/lib/activity";
import { readJsonBody } from "@/lib/parse-json";
import { gate } from "@/lib/auth/require";
import {
  createWorkspaceForUser,
  listWorkspacesForUser,
  mayCreateWorkspace,
  WorkspaceCreateError,
} from "@/lib/workspaces/registry";
import { withRoute } from "@/lib/route";
import { openWorkspace } from "@/lib/auth/workspace";
import { setBusinessSettings } from "@/lib/business/record-types";
import { applyBusinessTemplate, type BusinessTemplateResult } from "@/lib/business/templates";
import { viewPrincipal } from "@/lib/views/access";
import { BUSINESS_MODELS, type BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { listNodes as demoListNodes } from "@/lib/demo-store";
import type { Workspace } from "@bcontext-dev/contract/types";
import {
  WORKSPACE_NAME_MAX,
  type WorkspaceCard,
  type WorkspaceRole,
  type WorkspacesResponse,
} from "@bcontext-dev/contract/workspaces";

/**
 * `?stats=1` returns each workspace as a hub card: the caller's role and the
 * counts the card shows, plus whether they may create another. Opt-in,
 * because it is four more queries that an agent discovering its slug has no
 * use for.
 */
export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  const userId = gated.kind === "user" ? gated.userId : null;
  const workspaces = await listWorkspacesForUser(userId);
  if (new URL(req.url).searchParams.get("stats") !== "1") {
    return Response.json({ workspaces });
  }
  const cards = await withStats(workspaces, userId);
  const body: WorkspacesResponse = {
    workspaces: cards,
    can_create_workspace: await callerMayCreate(req, userId),
  };
  return Response.json(body);
});

/**
 * The instance-admin allowlist is by email, which only the auth server can
 * vouch for — so it is asked only when the policy is not simply `open`.
 */
async function callerMayCreate(req: Request, userId: string | null): Promise<boolean> {
  if (!isSupabaseConfigured()) return true;
  if (!userId) return false;
  if (mayCreateWorkspace(null)) return true;
  const { data } = await getSupabaseForRequest(req).auth.getUser();
  return mayCreateWorkspace(data.user?.email ?? null);
}

async function withStats(workspaces: Workspace[], userId: string | null): Promise<WorkspaceCard[]> {
  if (workspaces.length === 0) return [];
  if (!isSupabaseConfigured()) {
    // Demo store: one person, no roster, everything is theirs.
    return workspaces.map((w) => {
      const nodes = demoListNodes(w.slug);
      return {
        ...w,
        role: "owner",
        member_count: 1,
        open_task_count: nodes.filter((n) => n.kind === "task" && n.status !== "done").length,
        node_count: nodes.length,
        last_activity_at: nodes.reduce((acc, n) => (n.updated_at > acc ? n.updated_at : acc), w.created_at),
      };
    });
  }

  const admin = getSupabaseAdmin();
  const ids = workspaces.map((w) => w.id);
  // Mutually independent, so issued together rather than one after another.
  const [
    { data: mine },
    { data: members },
    { data: openTasks },
    { data: nodes },
    { data: activity },
  ] = await Promise.all([
    admin.from("memberships").select("workspace_id, role").eq("user_id", userId).in("workspace_id", ids),
    admin.from("memberships").select("workspace_id").in("workspace_id", ids).neq("role", "agent"),
    admin.from("nodes").select("workspace_id").in("workspace_id", ids).eq("kind", "task").neq("status", "done"),
    admin.from("nodes").select("workspace_id").in("workspace_id", ids),
    admin
      .from("activity")
      .select("workspace_id, created_at")
      .in("workspace_id", ids)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const count = (rows: unknown): Map<string, number> => {
    const out = new Map<string, number>();
    for (const r of (rows ?? []) as Array<{ workspace_id: string }>) {
      out.set(r.workspace_id, (out.get(r.workspace_id) ?? 0) + 1);
    }
    return out;
  };
  const role = new Map<string, WorkspaceRole>(
    ((mine ?? []) as Array<{ workspace_id: string; role: WorkspaceRole }>).map((m) => [m.workspace_id, m.role]),
  );
  const memberCount = count(members);
  const taskCount = count(openTasks);
  const nodeCount = count(nodes);
  const lastActivity = new Map<string, string>();
  for (const a of (activity ?? []) as Array<{ workspace_id: string; created_at: string }>) {
    if (!lastActivity.has(a.workspace_id)) lastActivity.set(a.workspace_id, a.created_at);
  }

  return workspaces.map((w) => ({
    ...w,
    role: role.get(w.id) ?? "viewer",
    member_count: memberCount.get(w.id) ?? 1,
    open_task_count: taskCount.get(w.id) ?? 0,
    node_count: nodeCount.get(w.id) ?? 0,
    last_activity_at: lastActivity.get(w.id) ?? w.created_at,
  }));
}

/**
 * The slug is not accepted: a workspace's address is derived from its name
 * (see `@/lib/slugs`).
 */
const CreateSchema = z.object({
  name: z.string().trim().min(1, "The workspace needs a name.").max(WORKSPACE_NAME_MAX),
  description: z.string().max(280).optional(),
  business_model: z.enum(BUSINESS_MODELS).optional(),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  if (isSupabaseConfigured() && gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to create a workspace." },
      { status: 401 },
    );
  }
  try {
    const userId = gated.kind === "user" ? gated.userId : null;
    const email = userId && isSupabaseConfigured()
      ? (await getSupabaseForRequest(req).auth.getUser()).data.user?.email ?? null
      : null;
    const { business_model, ...input } = parsed.data;
    const ws = await createWorkspaceForUser({ id: userId, email }, input);
    recordActivity(ws.id, "workspace", null, ws.name, "created");
    const businessTemplate = business_model && business_model !== "product"
      ? await applyCreationTemplate(req, ws.slug, business_model, userId)
      : undefined;
    return Response.json({ workspace: ws, ...(businessTemplate ? { business_template: businessTemplate } : {}) }, { status: 201 });
  } catch (err) {
    if (err instanceof WorkspaceCreateError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    // The demo store refuses a name whose slug is taken by throwing; that is
    // a conflict, not a server error.
    return Response.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 409 },
    );
  }
});

/**
 * A new workspace with a business model: set the model and apply its
 * template, as the creator (now its owner, through the same `openWorkspace`
 * every route uses). The workspace exists either way — a template that
 * fails part-way is reported in `skipped`, and re-applying it from the
 * business settings finishes the job without duplicating anything.
 */
async function applyCreationTemplate(
  req: Request,
  slug: string,
  model: BusinessModel,
  userId: string | null,
): Promise<BusinessTemplateResult | undefined> {
  const ctx = await openWorkspace(req, slug, "admin");
  if (ctx instanceof Response) return undefined;
  await setBusinessSettings(ctx.storage, { business_model: model });
  return applyBusinessTemplate(ctx.storage, await viewPrincipal(ctx.actor, ctx.storage), model, userId);
}
