/**
 * GET   /api/workspaces/:ws — the workspace, for anyone who can read it.
 * PATCH /api/workspaces/:ws — name and accent.
 *
 * GET also answers for a legacy `<org>~<workspace>` pair and always replies
 * with the current slug: that is how the web turns an old `/w/<org>/<ws>`
 * URL into its permanent redirect, without the web knowing anything about
 * the legacy table. PATCH is the settings panel's "General" section: admin
 * verb on the workspace, and a person — renaming a tenant is not something a
 * token does on its own. The slug is not patchable: it is the address.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { GRADIENTS } from "@bcontext-dev/contract/workspace-gradients";
import {
  WORKSPACE_NAME_MAX,
  type WorkspacePatch,
  type WorkspaceResponse,
} from "@bcontext-dev/contract/workspaces";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const body: WorkspaceResponse = { workspace: ctx.storage.workspace };
  return Response.json(body);
});

const Patch = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX).optional(),
  accent_hue: z.number().int().min(0).max(360).nullable().optional(),
  accent_gradient: z
    .string()
    .refine((id) => GRADIENTS.some((g) => g.id === id), "unknown gradient")
    .optional(),
}) satisfies z.ZodType<WorkspacePatch>;

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  if (actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Workspace settings need Supabase." },
      { status: 400 },
    );
  }

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Patch.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { name, accent_hue, accent_gradient } = parsed.data;
  const current = storage.workspace;

  const patch: Record<string, unknown> = {};
  if (name) patch.name = name;
  // Merged into the row's metadata so the accent does not clobber whatever
  // else lives in that jsonb. `null` hue means "leave the deterministic one".
  const meta: Record<string, unknown> = {};
  if (typeof accent_hue === "number") meta.accent_hue = accent_hue;
  if (accent_gradient) meta.accent_gradient = accent_gradient;
  if (Object.keys(meta).length > 0) {
    patch.metadata = { ...(current.metadata ?? {}), ...meta };
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ workspace: current });
  }

  const { data: row, error } = await getSupabaseAdmin()
    .from("workspaces")
    .update(patch)
    .eq("id", current.id)
    .select("id, slug, name, description, github_repo, metadata, created_at")
    .single();
  if (error || !row) {
    return Response.json(
      { error: "update_failed", message: error?.message ?? "update failed" },
      { status: 500 },
    );
  }
  return Response.json({ workspace: row });
});
