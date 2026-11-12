/**
 * Reads of business events for people: one subject's timeline (the account
 * 360 page) and the events an aggregate view groups (the marketplace's
 * supply vs demand heatmap, GMV by week). The rollup has its own read
 * (`events.ts`, canonical types only, all of them); these are narrower — by
 * subject, or by type and date — and bounded.
 *
 * Callers: `GET /api/workspaces/:ws/timeline`, `lib/views/business-payload.ts`.
 * Reached through `pg` like the rest of `business_events` (RLS gives the
 * table to the service role only). Must not break: every statement carries
 * `storage.workspace.id` — no RLS stands behind it — and a supplier's
 * timeline includes the bookings whose `properties.supplier_id` names it.
 *
 * Demo backend: the in-memory events `events.ts` keeps are reachable only
 * through `loadRollupEvents` (canonical types, no ids or subject types), so
 * the demo timeline and aggregates are built from those — enough for the
 * local demo and the tests, which only ever store canonical events.
 */
import type { BusinessTimelineEvent } from "@bcontext-dev/contract/business/timeline";
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

function rowToEvent(row: Record<string, unknown>, subjectId: string): BusinessTimelineEvent {
  const properties = (row.properties as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    type: String(row.type),
    occurred_at: new Date(row.occurred_at as string).toISOString(),
    subject_type: (row.subject_type as string | null) ?? null,
    subject_id: (row.subject_id as string | null) ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    properties,
    role: row.subject_id === subjectId ? "subject" : "supplier",
  };
}

/**
 * A subject's events, newest first, at most `limit` (+1 to know there are
 * more). `subjectType` narrows to events that named that type, but an event
 * sent without a `subject_type` still belongs to the id.
 */
export async function readSubjectTimeline(
  storage: Scoped,
  subject: { type: string | null; id: string },
  limit: number,
): Promise<{ events: BusinessTimelineEvent[]; more: boolean }> {
  if (storage.backend !== "supabase") {
    const all = (await loadRollupEvents(storage))
      .map((event, index) => ({ ...event, id: `demo-${index}`, subject_type: null }))
      .filter((event) => event.subject_id === subject.id || event.properties.supplier_id === subject.id)
      .reverse();
    return {
      events: all.slice(0, limit).map((event) => rowToEvent(event as unknown as Record<string, unknown>, subject.id)),
      more: all.length > limit,
    };
  }
  const result = await pool().query(
    `select id, type, occurred_at, subject_type, subject_id, amount, currency, properties
       from public.business_events
      where workspace_id = $1::uuid
        and ((subject_id = $2 and ($3::text is null or subject_type = $3 or subject_type is null))
             or properties->>'supplier_id' = $2)
      order by occurred_at desc, received_at desc, id desc
      limit $4`,
    [storage.workspace.id, subject.id, subject.type, limit + 1],
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  return { events: rows.slice(0, limit).map((row) => rowToEvent(row, subject.id)), more: rows.length > limit };
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
