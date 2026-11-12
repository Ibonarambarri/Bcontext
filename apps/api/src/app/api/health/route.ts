/**
 * Liveness/readiness probe for uptime monitoring (Better Stack).
 *
 * Point a Better Stack monitor at <APP_URL>/api/health. Returns 200 when the
 * app is healthy and its critical dependencies (Supabase, when configured) are
 * reachable; 503 when one is down so the monitor opens an incident.
 *
 *   - `db`   — GoTrue's /auth/v1/health through the gateway: Postgres and
 *              the auth service are up.
 *   - `rest` — one indexed read through the service-role client, i.e. the
 *              path every data route takes (supabase-js → kong → PostgREST).
 *              `db` alone kept answering "ok" for hours while PostgREST's
 *              pool timed out every request (PGRST003), so it is not enough.
 *
 * Both checks run in parallel with a 2.5s cap each, so a ping costs at most
 * one HEAD query and ~2.5s. Deliberately NOT wrapped with `withRoute` —
 * uptime pings hit this every 30–60s and we don't want a
 * request.started/completed log line per ping.
 */
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Check = "ok" | "down" | "skipped";

const CHECK_TIMEOUT_MS = 2500;

async function checkSupabase(): Promise<"ok" | "down"> {
  const url = supabaseUrl();
  const anon = supabaseAnonKey();
  if (!url || !anon) return "down";
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anon },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

async function checkRest(): Promise<Check> {
  // Without the service-role key the API has no data path to probe (it runs
  // on the in-memory demo store), so there is nothing to report as down.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return "skipped";
  try {
    // HEAD + limit 1: PostgREST still borrows a pool connection and runs the
    // query, which is exactly what we want to know, but returns no rows.
    const { error } = await getSupabaseAdmin()
      .from("workspaces")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    return error ? "down" : "ok";
  } catch {
    return "down";
  }
}

export async function GET(): Promise<Response> {
  const configured = isSupabaseConfigured();
  const [db, rest] = configured
    ? await Promise.all([checkSupabase(), checkRest()])
    : (["skipped", "skipped"] as const);
  const healthy = db !== "down" && rest !== "down";

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      db,
      rest,
      commit: process.env.SOURCE_COMMIT?.slice(0, 7) ?? null,
      ts: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
