/**
 * When each agent was last used, across every credential it authenticates
 * with.
 *
 * Called by the members screen (an agent a person connected) and the
 * instance admin's user detail. Read-only, service role.
 *
 * "Last used" is not one column. `agents.last_seen_at` is the durable
 * identity's own stamp, but a session is authenticated by a token, and each
 * of the three token tables keeps its own `last_used_at`. An agent that has
 * only ever connected over OAuth has a null `last_seen_at` and a live
 * `oauth_access_tokens.last_used_at`, so reading either one alone reports
 * agents as unused that are not. The newest across them is the honest
 * answer; a missing entry means nothing has recorded a use, which is a real
 * state (a connection approved and never taken up) and not a gap in the data.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function lastUsedByAgent(agentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (agentIds.length === 0) return out;
  const sb = getSupabaseAdmin();
  const tables = ["api_tokens", "oauth_access_tokens", "user_api_tokens"] as const;

  const results = await Promise.all(
    tables.map((table) =>
      sb
        .from(table)
        .select("agent_id, last_used_at")
        .in("agent_id", agentIds)
        .is("revoked_at", null),
    ),
  );

  for (const { data } of results) {
    for (const row of (data ?? []) as Array<{
      agent_id: string | null;
      last_used_at: string | null;
    }>) {
      if (!row.agent_id || !row.last_used_at) continue;
      const best = newest(out.get(row.agent_id) ?? null, row.last_used_at);
      if (best) out.set(row.agent_id, best);
    }
  }
  return out;
}

export function newest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
