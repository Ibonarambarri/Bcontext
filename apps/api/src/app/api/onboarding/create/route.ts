/**
 * POST /api/onboarding/create
 *   { name: string, template?: string, description?: string }
 *
 * One-shot onboarding: creates a Supabase workspace owned by the current
 * user, applies the chosen ICP template and returns what the UI needs to
 * render the success page (workspace + where to go next).
 *
 * No token is minted here: the success screen stopped showing one, and a
 * credential nobody sees is a credential nobody revokes. Agents connect
 * later from the Agents tab, which issues tokens on demand.
 *
 * Requires an authenticated user session.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import {
  createWorkspaceForUser,
  WorkspaceCreateError,
} from "@/lib/workspaces/registry";
import { applyTemplateById } from "@/lib/templates/apply";
import { listTemplates } from "@bcontext-dev/contract/templates/workspaces";
import { getStorageById } from "@/lib/storage";
import { withRoute } from "@/lib/route";
import { getSupabaseForRequest } from "@/lib/supabase/request";

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  template: z.string().min(1).max(64).optional(),
  description: z.string().max(280).optional(),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to onboard." },
      { status: 401 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = Body.safeParse(parsed.data);
  if (!body.success) {
    return Response.json(
      { error: body.error.flatten() },
      { status: 400 },
    );
  }

  // 1. Create the workspace and its reusable starter tags.
  let workspace;
  try {
    // The creation policy is by email, which only the auth server vouches for.
    const { data } = await getSupabaseForRequest(req).auth.getUser();
    workspace = await createWorkspaceForUser(
      { id: gated.userId, email: data.user?.email ?? null },
      { name: body.data.name, description: body.data.description },
    );
  } catch (err) {
    if (err instanceof WorkspaceCreateError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    throw err;
  }

  // 2. Apply the chosen template (if any) — idempotent so re-runs are safe.
  let templateResult = null;
  if (body.data.template) {
    const valid = listTemplates().some((t) => t.id === body.data.template);
    if (valid) {
      // Addressed by id: it is what the create just returned.
      const storage = await getStorageById(workspace.id);
      if (storage) {
        templateResult = await applyTemplateById(storage, body.data.template);
      }
    }
  }

  return Response.json(
    {
      workspace,
      template: templateResult,
      next_url: `/workspaces`,
    },
    { status: 201 },
  );
});
