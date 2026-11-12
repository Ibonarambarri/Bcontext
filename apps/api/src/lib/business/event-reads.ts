/**
 * The events an aggregate view groups (the marketplace's supply vs demand
 * heatmap, GMV by week): by type and date, most recent first, bounded. The
 * rollup has its own read (`events.ts`, canonical types only, all of them);
 * one subject's events are `listSubjectEvents` there, behind
 * `GET /api/workspaces/:ws/events?subject_…`.
 *
 * Caller: `lib/views/business-payload.ts`. Reached through `pg` like the
 * rest of `business_events` (RLS gives the table to the service role only).
 * Must not break: every statement carries `storage.workspace.id` — no RLS
 * stands behind it.
 *
 * Demo backend: the in-memory events `events.ts` keeps are reachable only
 * through `loadRollupEvents` (canonical types), so demo aggregates are built
 * from those — enough for the local demo and the tests, which only ever store
 * canonical events.
 */
import { BUSINESS_VIEW_LIMITS } from "@bcontext-dev/contract/views/business";
import type { Storage } from "@/lib/storage";
import { getPool, hasDatabaseUrl } from "@/lib/queue/db";
import { BusinessBackendError, loadRollupEvents } from "./events";

type Scoped = Pick<Storage, "backend" | "workspace">;

function pool() {
  if (!hasDatabaseUrl()) {
    throw new BusinessBackendError("business events need a direct database connection (DATABASE_URL); this process has none");
  }
  return getPool();
}

export interface AggregateEventRow {
  type: string;
  occurred_at: string;
  subject_id: string | null;
  amount: number | null;
  currency: string | null;
  properties: Record<string, unknown>;
}

/**
 * Events of the given types for an aggregate, most recent first and capped
 * (`BUSINESS_VIEW_LIMITS.maxEventsScanned`): a heatmap of the last weeks must
 * not scan years of bookings. `truncated` says the cap was hit, so the view
 * can say its oldest buckets are partial.
 */
export async function readEventsForAggregate(
  storage: Scoped,
  types: readonly string[],
  since: string | null,
): Promise<{ rows: AggregateEventRow[]; truncated: boolean }> {
  const cap = BUSINESS_VIEW_LIMITS.maxEventsScanned;
  if (storage.backend !== "supabase") {
    const rows = (await loadRollupEvents(storage))
      .filter((event) => types.includes(event.type) && (!since || event.occurred_at >= since))
      .reverse();
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  }
  const result = await pool().query(
    `select type, occurred_at, subject_id, amount, currency, properties
       from public.business_events
      where workspace_id = $1::uuid
        and type = any($2::text[])
        and ($3::timestamptz is null or occurred_at >= $3::timestamptz)
      order by occurred_at desc
      limit $4`,
    [storage.workspace.id, [...types], since, cap + 1],
  );
  const rows = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    type: String(row.type),
    occurred_at: new Date(row.occurred_at as string).toISOString(),
    subject_id: (row.subject_id as string | null) ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    properties: (row.properties as Record<string, unknown>) ?? {},
  }));
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}
