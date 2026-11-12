/**
 * Workspace catalog — cross-workspace operations (list, create) that the
 * per-workspace Storage abstraction does not handle, and the instance policy
 * on who may create one.
 *
 * Called by `GET/POST /api/workspaces`, `POST /api/onboarding/create`,
 * `/api/me` and `/api/signup` (the policy), and the instance admin's
 * create-and-invite flow (`insertWorkspace`). Creating lands in Supabase when
 * configured, or in the in-memory demo-store when not.
 *
 * Who may create a workspace is the instance's choice, `WORKSPACE_CREATION`:
 *   open   (default) any signed-in person — and anyone may sign up;
 *   admin  only the instance admins (`ADMIN_EMAILS`), who invite the owners.
 *
 * Must not break: a workspace nobody can open is worse than none, so the
 * creator's owner membership and grant are written with the row, and a
 * failure after the row is written undoes it.
 */
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminEmail } from "@/lib/admin/access";
import type { Workspace } from "@bcontext-dev/contract/types";
import {
  WORKSPACE_NAME_MAX,
  type WorkspaceCreationPolicy,
} from "@bcontext-dev/contract/workspaces";
import {
  createWorkspace as demoCreate,
  listWorkspaces as demoList,
} from "@/lib/demo-store";
import { baseSlug, disambiguate } from "@/lib/slugs";
import { supabaseConfigured } from "@/lib/env";
import { log } from "@bcontext-dev/contract/log";

export interface CreateWorkspaceInput {
  name: string;
  /** Demo storage only — with Supabase the slug is always generated. */
  slug?: string;
  description?: string | null;
}

/**
 * `WORKSPACE_CREATION`, read per call so a test (or an operator) can flip it.
 *
 * `ORG_CREATION` is still read when the new name is absent: it is what every
 * `.env` written before 0100 carries, and silently falling back to `open`
 * would turn an instance whose admin had closed self-service into one anyone
 * can sign up to.
 */
export function workspaceCreationPolicy(): WorkspaceCreationPolicy {
  const raw = (process.env.WORKSPACE_CREATION ?? process.env.ORG_CREATION ?? "")
    .trim()
    .toLowerCase();
  return raw === "admin" ? "admin" : "open";
}

/** Whether a person with this address may create a workspace here. */
export function mayCreateWorkspace(email: string | null | undefined): boolean {
  return workspaceCreationPolicy() === "open" || isAdminEmail(email);
}

/**
 * List workspaces visible to a user: the ones they hold a membership in.
 * Without Supabase, the in-memory demo workspaces.
 */
export async function listWorkspacesForUser(
  userId: string | null,
): Promise<Workspace[]> {
  if (!supabaseConfigured()) return demoList();
  if (!userId) return [];
  const admin = getSupabaseAdmin();
  const { data: memberships } = await admin
    .from("memberships")
    .select("workspace_id")
    .eq("user_id", userId);
  const ids = (memberships ?? []).map((m: { workspace_id: string }) => m.workspace_id);
  if (ids.length === 0) return [];
  const { data } = await admin.from("workspaces").select("*").in("id", ids);
  return ((data ?? []) as Record<string, unknown>[])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(rowToWorkspace);
}

export class WorkspaceCreateError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkspaceCreateError";
  }
}

/**
 * Write the workspace row, nothing else. The slug comes from `slug` when
 * given (instance admin) or the name, and is disambiguated across the
 * instance (`docs`, `docs-2`) — except with `strictSlug`, where an address
 * somebody typed is taken as is or refused with 409 `slug_taken`.
 */
export async function insertWorkspace(input: {
  name: string;
  slug?: string;
  strictSlug?: boolean;
  description?: string | null;
}): Promise<Workspace> {
  const name = input.name.trim().slice(0, WORKSPACE_NAME_MAX);
  if (!name) {
    throw new WorkspaceCreateError(400, "invalid_name", "The workspace needs a name.");
  }
  const admin = getSupabaseAdmin();
  const wanted = baseSlug(input.slug?.trim() || name, "workspace");
  const taken = await takenSlugs(wanted);
  let slug = wanted;
  if (input.slug?.trim() && input.strictSlug) {
    if (taken.includes(wanted)) {
      throw new WorkspaceCreateError(409, "slug_taken", `The address "${wanted}" is already in use.`);
    }
  } else {
    slug = disambiguate(wanted, taken);
  }

  const { data, error } = await admin
    .from("workspaces")
    .insert({ slug, name, description: input.description ?? null })
    .select("*")
    .single();
  if (error || !data) {
    // A unique violation here is a race with another create of the same slug.
    if (error?.code === "23505") {
      throw new WorkspaceCreateError(409, "slug_taken", `The address "${slug}" is already in use.`);
    }
    throw new Error(`insertWorkspace: ${error?.message ?? "no row returned"}`);
  }
  return rowToWorkspace(data);
}

/**
 * Create a workspace owned by the caller, if the instance lets them.
 *
 * The slug is derived from the name and disambiguated with a number — never
 * supplied by the caller — because it is an address, not a label.
 */
export async function createWorkspaceForUser(
  user: { id: string | null; email?: string | null },
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  if (!supabaseConfigured() || !user.id) {
    // Demo path — keep behaviour identical to before.
    return demoCreate({
      name: input.name,
      slug: input.slug,
      description: input.description ?? undefined,
    });
  }
  if (!mayCreateWorkspace(user.email)) {
    throw new WorkspaceCreateError(
      403,
      "workspace_creation_restricted",
      "On this instance, workspaces are created by an administrator.",
    );
  }

  const ws = await insertWorkspace({ name: input.name, description: input.description });
  const admin = getSupabaseAdmin();

  // The creator's own access, written at the same moment as the row: a
  // membership (what node RLS gates on) and the grant that is authoritative.
  const { error: memberErr } = await admin.from("memberships").insert({
    user_id: user.id,
    workspace_id: ws.id,
    role: "owner",
  });
  if (memberErr) {
    // Deleting the workspace cascades to anything already written for it,
    // so pressing the button again is a clean retry.
    await admin.from("workspaces").delete().eq("id", ws.id);
    throw new Error(`createWorkspace: owner membership failed: ${memberErr.message}`);
  }
  await syncGrantFromMembership(ws.id, user.id, "owner", { reinstate: true });

  log.info("workspace.created", {
    workspace_id: ws.id,
    slug: ws.slug,
    policy: workspaceCreationPolicy(),
  });
  return ws;
}

/** Slugs already in use that `disambiguate` must step around. */
async function takenSlugs(base: string): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("workspaces")
    .select("slug")
    .like("slug", `${base}%`);
  return ((data ?? []) as Array<{ slug: string }>).map((r) => r.slug.toLowerCase());
}

export function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    github_repo: (row.github_repo as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
  };
}
