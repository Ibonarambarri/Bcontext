/**
 * The workspace a request names, as a row.
 *
 * Every way a workspace can be named ends up here: its slug (the address
 * today — `/w/<slug>`, `/mcp/<slug>`, `?workspace=<slug>`), its id, or one of
 * the `<org>/<workspace>` / `<org>~<workspace>` pairs written before
 * organizations were removed. Called by storage resolution (and so by
 * `openWorkspace`), the agent workspace selector in `@/lib/auth/require`, the
 * MCP / OAuth resource binding, and the few routes that need the row rather
 * than a `Storage`.
 *
 * Must not break: a legacy pair resolves through `workspace_legacy_refs`
 * first, because 0100 renamed the slugs that collided across organizations —
 * the second half of an old pair is not always the slug any more. Only a
 * pair the table does not know falls back to its workspace half, which is
 * what an old client pointed at a workspace created after 0100 would send.
 * This module never authorises anything; callers still check the grant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

/**
 * The workspace row named by `named` (slug, id or legacy pair), or null.
 * `columns` is a PostgREST select list. `client` defaults to the service
 * role; callers that were handed a client (the OAuth grant code) pass it on.
 */
export async function findWorkspaceByRef(
  named: string | null | undefined,
  columns = "id, slug, name",
  client?: SupabaseClient,
): Promise<Row | null> {
  const value = (named ?? "").trim().toLowerCase();
  if (!value) return null;
  const admin = client ?? getSupabaseAdmin();

  if (UUID.test(value)) {
    const { data } = await admin.from("workspaces").select(columns).eq("id", value).maybeSingle();
    return (data as Row | null) ?? null;
  }

  const ref = parseWorkspaceRef(value);
  if (!ref) return null;

  if (ref.kind === "legacy") {
    const { data: legacy } = await admin
      .from("workspace_legacy_refs")
      .select("workspace_id")
      .eq("legacy_ref", ref.name)
      .maybeSingle();
    const id = (legacy as { workspace_id?: string } | null)?.workspace_id;
    if (id) {
      const { data } = await admin.from("workspaces").select(columns).eq("id", id).maybeSingle();
      return (data as Row | null) ?? null;
    }
  }

  const slug = ref.kind === "slug" ? ref.slug : ref.legacy.workspace;
  const { data } = await admin.from("workspaces").select(columns).eq("slug", slug).maybeSingle();
  return (data as Row | null) ?? null;
}
