/**
 * Ingest keys: write-only credentials a SaaS app uses to push its records and
 * events (`ingest_keys`, 0103).
 *
 * Format `bctx_ingest_<43 chars>`, stored as sha256 of the suffix, shown
 * once — the same scheme as `auth/tokens.ts`. The prefix is the security
 * property: `parseAuthHeader` there accepts only `bctx_live_…`, so this key
 * is "invalid_token" on every route and on MCP, and only `openIngestWorkspace`
 * (auth/workspace.ts) accepts it. Nothing here has to remember to deny reads.
 *
 * Callers: `/api/workspaces/:ws/ingest-keys` (people with the admin verb
 * mint, list and revoke), `openIngestWorkspace` (verify). Must not break:
 * the plaintext is never stored or logged, and a revoked key never verifies.
 */
import { customAlphabet } from "nanoid";
import { INGEST_KEY_PREFIX, type IngestKey } from "@bcontext-dev/contract/business/ingest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sha256Hex, TokenLookupUnavailableError } from "@/lib/auth/tokens";

const SUFFIX_LENGTH = 43;
const generateSuffix = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", SUFFIX_LENGTH);
const COLUMNS = "id, workspace_id, name, prefix, last4, created_at, last_used_at, revoked_at";

function toKey(row: Record<string, unknown>): IngestKey {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    name: String(row.name),
    prefix: String(row.prefix),
    last4: String(row.last4),
    created_at: String(row.created_at),
    last_used_at: (row.last_used_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}

export async function createIngestKey(
  workspaceId: string,
  name: string,
  createdBy: string | null,
): Promise<{ key: string; record: IngestKey }> {
  const suffix = generateSuffix();
  const key = `${INGEST_KEY_PREFIX}${suffix}`;
  const { data, error } = await getSupabaseAdmin()
    .from("ingest_keys")
    .insert({
      workspace_id: workspaceId,
      name,
      prefix: key.slice(0, INGEST_KEY_PREFIX.length + 4),
      last4: key.slice(-4),
      hash: await sha256Hex(suffix),
      created_by: createdBy,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`createIngestKey: ${error?.message ?? "unknown"}`);
  return { key, record: toKey(data as Record<string, unknown>) };
}

export async function listIngestKeys(workspaceId: string): Promise<IngestKey[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("ingest_keys")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listIngestKeys: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toKey);
}

/** Soft-revoke; false when no live key of this workspace has that id. */
export async function revokeIngestKey(workspaceId: string, id: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("ingest_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`revokeIngestKey: ${error.message}`);
  return (data ?? []).length > 0;
}

/** `Bearer bctx_ingest_…` → the suffix, or null for anything else. */
export function parseIngestAuthHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+bctx_ingest_([A-Za-z0-9]+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * The key behind a header, or null (missing, malformed, unknown, revoked).
 * Throws `TokenLookupUnavailableError` when the backend could not answer, so
 * the caller says 503 and the sender retries instead of rotating a good key.
 */
export async function verifyIngestKey(
  header: string | null | undefined,
): Promise<{ id: string; workspaceId: string } | null> {
  const suffix = parseIngestAuthHeader(header);
  if (!suffix) return null;
  const admin = getSupabaseAdmin();
  let result: { data: unknown; error: unknown };
  try {
    result = await admin
      .from("ingest_keys")
      .select("id, workspace_id, revoked_at")
      .eq("hash", await sha256Hex(suffix))
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
  } catch (err) {
    throw new TokenLookupUnavailableError("ingest_keys", err);
  }
  if (result.error) throw new TokenLookupUnavailableError("ingest_keys", result.error);
  const row = result.data as { id: string; workspace_id: string; revoked_at: string | null } | null;
  if (!row || row.revoked_at) return null;
  void admin.from("ingest_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id).then(
    () => undefined,
    () => undefined,
  );
  return { id: row.id, workspaceId: row.workspace_id };
}
