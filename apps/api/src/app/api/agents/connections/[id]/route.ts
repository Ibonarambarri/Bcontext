/**
 * One agent's connection to a workspace, edited from the Agents page.
 *
 *   PATCH  /api/agents/connections/:id            role, scopes, identity
 *   DELETE /api/agents/connections/:id?workspace=  disconnect from this workspace
 *
 * Session-cookie owner|admin of the workspace (`adminContext`). Identity
 * fields (name, provider, description) only stick when the caller also owns
 * the agent. The policy write is one RPC so role and scopes land in a single
 * transaction with the token re-scope; tokens are re-scoped to the intersection
 * of every workspace policy the agent still holds, and disconnecting from the
 * last workspace revokes the agent everywhere.
 */
import { z } from "zod";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";
import { SCOPES, type Scope } from "@bcontext-dev/contract/auth/scopes";
import { AGENT_PROVIDERS, AGENT_ROLES } from "@bcontext-dev/contract/agents/connections";
import { revokeAgentEverywhere } from "@/lib/agents/connections.server";
import { appendAudit } from "@/lib/audit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { withRoute } from "@/lib/route";
import { syncGrantFromAgentAccess } from "@/lib/auth/grant-sync";

const ParamsSchema = z.object({ id: z.string().uuid() });
const UpdateSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional(),
  provider_label: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(240).optional(),
  role: z.enum(AGENT_ROLES),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
});

type AdminContext =
  | { ok: false; response: Response }
  | { ok: true; admin: ReturnType<typeof getSupabaseAdmin>; userId: string; workspaceId: string };

async function adminContext(req: Request, workspaceSlug: string, agentId: string): Promise<AdminContext> {
  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const admin = getSupabaseAdmin();
  const workspace = await findWorkspaceByRef(workspaceSlug, "id, slug");
  if (!workspace) return { ok: false, response: Response.json({ error: "workspace_not_found" }, { status: 404 }) };
  const { data: membership } = await admin
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspace.id)
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (!membership || !["owner", "admin"].includes(membership.role as string)) {
    return { ok: false, response: Response.json({ error: "forbidden", message: "owner or admin role required" }, { status: 403 }) };
  }
  const { data: access } = await admin
    .from("agent_workspace_access")
    .select("agent_id")
    .eq("agent_id", agentId)
    .eq("workspace_id", workspace.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (!access) return { ok: false, response: Response.json({ error: "agent_not_found" }, { status: 404 }) };
  return { ok: true, admin, userId: session.user.id, workspaceId: workspace.id as string };
}

export const PATCH = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return Response.json({ error: "invalid_agent_id" }, { status: 400 });
  const input = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: "invalid_request", issues: input.error.flatten() }, { status: 400 });
  const context = await adminContext(req, input.data.workspace, params.data.id);
  if (!context.ok) return context.response;
  const { admin, userId, workspaceId } = context;

  const { data: agent } = await admin
    .from("agents")
    .select("owner_user_id")
    .eq("id", params.data.id)
    .maybeSingle();
  if (!agent) return Response.json({ error: "agent_not_found" }, { status: 404 });

  const identityPatch = agent.owner_user_id === userId ? {
    ...(input.data.name ? { name: input.data.name } : {}),
    ...(input.data.provider ? { provider: input.data.provider } : {}),
    ...(input.data.provider_label !== undefined ? { provider_label: input.data.provider_label } : {}),
    ...(input.data.description !== undefined ? { description: input.data.description } : {}),
  } : {};
  // Role, scopes and the token re-scope in one transaction (0099), so a
  // concurrent edit of the same agent cannot interleave between them.
  const { data: policy, error: policyError } = await admin.rpc("update_agent_connection_policy", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_agent_id: params.data.id,
    p_role: input.data.role,
    p_scopes: input.data.scopes,
  }).single();
  if (policyError) {
    const missingAgent = policyError.message.includes("agent_connection_not_found");
    return Response.json({
      error: missingAgent ? "agent_not_found" : "connection_policy_update_failed",
      message: policyError.message,
    }, { status: missingAgent ? 404 : 500 });
  }
  if (Object.keys(identityPatch).length > 0) {
    const { error: identityError } = await admin.from("agents").update(identityPatch).eq("id", params.data.id);
    if (identityError) return Response.json({ error: "agent_update_failed", message: identityError.message }, { status: 500 });
  }

  // The RPC also synchronizes every active token to the intersection of all
  // workspace policies in the same transaction.
  const effectiveScopes = ((policy as { effective_scopes?: Scope[] } | null)?.effective_scopes ?? []);
  // The scopes just approved for *this* workspace, not the cross-workspace
  // intersection the tokens carry: a grant answers for one workspace, so
  // narrowing an agent elsewhere must not narrow it here.
  await syncGrantFromAgentAccess(workspaceId, params.data.id, input.data.scopes);
  void appendAudit({
    workspaceId,
    actorType: "user",
    actorId: userId,
    action: "agent.connection.update",
    targetType: "agent",
    targetId: params.data.id,
    input: { role: input.data.role, scopes: input.data.scopes },
  });
  return Response.json({ ok: true, effective_scopes: effectiveScopes });
});

export const DELETE = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return Response.json({ error: "invalid_agent_id" }, { status: 400 });
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspace) return Response.json({ error: "workspace_required" }, { status: 400 });
  const context = await adminContext(req, workspace, params.data.id);
  if (!context.ok) return context.response;
  const { admin, userId, workspaceId } = context;
  const now = new Date().toISOString();
  await admin.from("agent_workspace_access").update({ revoked_at: now }).eq("agent_id", params.data.id).eq("workspace_id", workspaceId);
  // Grants are authoritative, so disconnecting from one workspace has to
  // revoke the grant for that workspace too. Without this the agent kept read
  // and write here after being disconnected: nothing else denies it any more,
  // so the responsibility sits on this line.
  await syncGrantFromAgentAccess(workspaceId, params.data.id, null);
  const { count } = await admin.from("agent_workspace_access").select("agent_id", { count: "exact", head: true }).eq("agent_id", params.data.id).is("revoked_at", null);
  if (!count) await revokeAgentEverywhere(admin, params.data.id);
  else await syncAgentTokenScopes(admin, params.data.id);
  void appendAudit({ workspaceId, actorType: "user", actorId: userId, action: "agent.connection.revoke", targetType: "agent", targetId: params.data.id });
  return Response.json({ ok: true, revoked_everywhere: !count });
});

function intersectScopes(policies: Scope[][]): Scope[] {
  if (policies.length === 0) return [];
  return policies[0]!.filter((scope) => policies.every((policy) => policy.includes(scope)));
}

async function syncAgentTokenScopes(
  admin: ReturnType<typeof getSupabaseAdmin>,
  agentId: string,
): Promise<Scope[]> {
  const { data: policies } = await admin
    .from("agent_workspace_access")
    .select("scopes")
    .eq("agent_id", agentId)
    .is("revoked_at", null);
  const effectiveScopes = intersectScopes(
    ((policies ?? []) as Array<{ scopes: Scope[] }>).map((row) => row.scopes),
  );
  await Promise.all([
    admin.from("api_tokens").update({ scopes: effectiveScopes }).eq("agent_id", agentId).is("revoked_at", null),
    admin.from("oauth_access_tokens").update({ scopes: effectiveScopes }).eq("agent_id", agentId).is("revoked_at", null),
    admin.from("user_api_tokens").update({ scopes: effectiveScopes }).eq("agent_id", agentId).is("revoked_at", null),
  ]);
  return effectiveScopes;
}
