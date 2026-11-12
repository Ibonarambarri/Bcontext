/**
 * Business events and their rollups, in the database (`business_events`,
 * `business_metric_rollups`, 0103).
 *
 * Callers: `POST /api/workspaces/:ws/events` (insert) and its `GET` (one
 * subject's events, for a record's 360 page), the record erasure
 * path (unlink), the `business.rollup` worker job (read events, replace
 * rollups) and the metrics summary (read month rollups).
 *
 * Reached through `pg`, like dataset rows: the batch insert with ON CONFLICT
 * and the rollup's replace-in-a-transaction are not expressible through
 * PostgREST. The demo backend keeps both in memory so the local demo and the
 * tests run the whole loop — ingest, rollup, summary — without Postgres.
 *
 * Must not break: every statement carries the workspace id (service-role,
 * no RLS in the path), and a retried event is a no-op — the unique
 * (workspace_id, idempotency_key) is what makes that true under concurrency,
 * not a read-then-write here.
 */
import { randomUUID } from "node:crypto";
import {
  CANONICAL_EVENT_TYPES,
  type SubjectEvent,
  type BusinessEventInput,
  type EventIngestStatus,
} from "@bcontext-dev/contract/business/events";
import type { MetricGrain, MetricRollupRow, RollupMetric } from "@bcontext-dev/contract/business/metrics";
import type { Storage } from "@/lib/storage";
import { getPool, hasDatabaseUrl, withTransaction } from "@/lib/queue/db";

export class BusinessBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessBackendError";
  }
}

type Scoped = Pick<Storage, "backend" | "workspace">;

/** What the rollup reads: the canonical facts, in time order. */
export interface RollupEvent {
  type: string;
  occurred_at: string;
  subject_id: string | null;
  amount: number | null;
  currency: string | null;
  properties: Record<string, unknown>;
}

/* -- demo backend ------------------------------------------------------------ */

interface DemoEvent extends RollupEvent {
  id: string;
  idempotency_key: string;
  subject_type: string | null;
}
const demoEvents = new Map<string, DemoEvent[]>();
const demoRollups = new Map<string, { rows: MetricRollupRow[]; computed_at: string }>();

export function _resetDemoEvents(): void {
  demoEvents.clear();
  demoRollups.clear();
}

function pool() {
  if (!hasDatabaseUrl()) {
    throw new BusinessBackendError("business events need a direct database connection (DATABASE_URL); this process has none");
  }
  return getPool();
}

/* -- events ------------------------------------------------------------------ */

export interface InsertedEvent {
  idempotency_key: string;
  status: Extract<EventIngestStatus, "stored" | "duplicate">;
  id?: string;
}

/**
 * Insert validated events; a key already stored (now, or earlier in the same
 * batch) comes back `duplicate` and nothing is written for it.
 */
export async function insertEvents(
  storage: Scoped,
  events: readonly BusinessEventInput[],
  ingestKeyId: string | null,
): Promise<InsertedEvent[]> {
  if (events.length === 0) return [];
  if (storage.backend !== "supabase") {
    const list = demoEvents.get(storage.workspace.id) ?? [];
    const keys = new Set(list.map((event) => event.idempotency_key));
    const out: InsertedEvent[] = [];
    for (const event of events) {
      if (keys.has(event.idempotency_key)) {
        out.push({ idempotency_key: event.idempotency_key, status: "duplicate" });
        continue;
      }
      const id = randomUUID();
      keys.add(event.idempotency_key);
      list.push({
        id,
        idempotency_key: event.idempotency_key,
        type: event.type,
        occurred_at: new Date(event.occurred_at).toISOString(),
        subject_type: event.subject_type ?? null,
        subject_id: event.subject_id ?? null,
        amount: event.amount ?? null,
        currency: event.currency ?? null,
        properties: event.properties ?? {},
      });
      out.push({ idempotency_key: event.idempotency_key, status: "stored", id });
    }
    demoEvents.set(storage.workspace.id, list);
    return out;
  }
  const payload = events.map((event) => ({
    type: event.type,
    occurred_at: event.occurred_at,
    subject_type: event.subject_type ?? null,
    subject_id: event.subject_id ?? null,
    amount: event.amount ?? null,
    currency: event.currency ?? null,
    properties: event.properties ?? {},
    idempotency_key: event.idempotency_key,
  }));
  const result = await pool().query(
    `insert into public.business_events
       (workspace_id, type, occurred_at, subject_type, subject_id, amount, currency, properties, idempotency_key, ingest_key_id)
     select $1::uuid, t.type, t.occurred_at, t.subject_type, t.subject_id, t.amount, t.currency,
            coalesce(t.properties, '{}'::jsonb), t.idempotency_key, $3::uuid
       from jsonb_to_recordset($2::jsonb) as t(
         type text, occurred_at timestamptz, subject_type text, subject_id text,
         amount numeric, currency text, properties jsonb, idempotency_key text)
     on conflict (workspace_id, idempotency_key) do nothing
     returning id, idempotency_key`,
    [storage.workspace.id, JSON.stringify(payload), ingestKeyId],
  );
  const stored = new Map<string, string>();
  for (const row of result.rows as Array<{ id: string; idempotency_key: string }>) stored.set(row.idempotency_key, row.id);
  const claimed = new Set<string>();
  return events.map((event) => {
    const id = stored.get(event.idempotency_key);
    // A key repeated inside one batch is stored once: the first occurrence
    // claims the row, the rest are duplicates of it.
    if (id && !claimed.has(event.idempotency_key)) {
      claimed.add(event.idempotency_key);
      return { idempotency_key: event.idempotency_key, status: "stored", id };
    }
    return { idempotency_key: event.idempotency_key, status: "duplicate" };
  });
}

/**
 * Replace a subject's id on its events with one random token (see
 * `eraseRecord`): as the subject, and as a booking's supplier. Returns how
 * many events changed.
 */
export async function unlinkSubject(storage: Scoped, subjectType: string, subjectId: string): Promise<number> {
  const token = `erased:${randomUUID()}`;
  if (storage.backend !== "supabase") {
    let count = 0;
    for (const event of demoEvents.get(storage.workspace.id) ?? []) {
      let touched = false;
      if (event.subject_id === subjectId && (event.subject_type === subjectType || event.subject_type === null)) {
        event.subject_id = token;
        touched = true;
      }
      if (event.properties.supplier_id === subjectId) {
        event.properties = { ...event.properties, supplier_id: token };
        touched = true;
      }
      if (touched) count++;
    }
    return count;
  }
  const result = await pool().query(
    `update public.business_events
        set subject_id = case when subject_id = $2 and (subject_type = $3 or subject_type is null) then $4 else subject_id end,
            properties = case when properties->>'supplier_id' = $2
                              then jsonb_set(properties, '{supplier_id}', to_jsonb($4::text)) else properties end,
            subject_erased_at = now()
      where workspace_id = $1::uuid
        and ((subject_id = $2 and (subject_type = $3 or subject_type is null))
             or properties->>'supplier_id' = $2)`,
    [storage.workspace.id, subjectId, subjectType, token],
  );
  return result.rowCount ?? 0;
}

/**
 * One subject's events, newest first — a record's 360 timeline
 * (`GET /events?subject_type=&subject_id=`). An event sent without a
 * `subject_type` belongs to whichever type asks, the same reading
 * `unlinkSubject` gives it. Bookings that name the id as their supplier
 * (`properties.supplier_id`) are included with `role: "supplier"`, as
 * erasure unlinks them — except when the asking type is the booking's own
 * subject type, so a buyer and a supplier that share an id do not mix.
 *
 * `booking.completed` / `booking.canceled` need not repeat the supplier: they
 * join to the supplier's bookings on `properties.booking_id` (the
 * `booking.created` that names it), so a supplier's timeline shows how its
 * bookings ended without asking senders to change their payloads.
 */
export async function listSubjectEvents(
  storage: Scoped,
  subjectType: string,
  subjectId: string,
  limit: number,
): Promise<SubjectEvent[]> {
  const isSubject = (event: { subject_id: string | null; subject_type: string | null }) =>
    event.subject_id === subjectId && (event.subject_type === subjectType || event.subject_type === null);
  if (storage.backend !== "supabase") {
    const all = demoEvents.get(storage.workspace.id) ?? [];
    const supplierBookings = new Set(all
      .filter((event) => event.type === "booking.created" && event.properties.supplier_id === subjectId)
      .map((event) => event.properties.booking_id)
      .filter((id): id is string => typeof id === "string"));
    return [...all]
      .filter((event) => isSubject(event) || (
        event.type.startsWith("booking.") && event.subject_type !== subjectType && (
          event.properties.supplier_id === subjectId ||
          (typeof event.properties.booking_id === "string" && supplierBookings.has(event.properties.booking_id))
        )
      ))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        workspace_id: storage.workspace.id,
        type: event.type,
        occurred_at: event.occurred_at,
        idempotency_key: event.idempotency_key,
        ...(event.subject_type ? { subject_type: event.subject_type } : {}),
        ...(event.subject_id ? { subject_id: event.subject_id } : {}),
        ...(event.amount !== null ? { amount: event.amount } : {}),
        ...(event.currency ? { currency: event.currency } : {}),
        properties: event.properties,
        received_at: event.occurred_at,
        subject_erased_at: null,
        role: isSubject(event) ? ("subject" as const) : ("supplier" as const),
      }));
  }
  const result = await pool().query(
    `select id, type, occurred_at, received_at, idempotency_key, subject_type, subject_id,
            amount, currency, properties, subject_erased_at
       from public.business_events
      where workspace_id = $1::uuid
        and ((subject_id = $2 and (subject_type = $3 or subject_type is null))
             or (type like 'booking.%' and subject_type is distinct from $3
                 and (properties->>'supplier_id' = $2
                      or properties->>'booking_id' in (
                        select created.properties->>'booking_id'
                          from public.business_events created
                         where created.workspace_id = $1::uuid
                           and created.type = 'booking.created'
                           and created.properties->>'supplier_id' = $2))))
      order by occurred_at desc, received_at desc, id desc
      limit $4`,
    [storage.workspace.id, subjectId, subjectType, limit],
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    workspace_id: storage.workspace.id,
    type: String(row.type),
    occurred_at: new Date(row.occurred_at as string).toISOString(),
    received_at: new Date(row.received_at as string).toISOString(),
    idempotency_key: String(row.idempotency_key),
    ...(row.subject_type ? { subject_type: String(row.subject_type) } : {}),
    ...(row.subject_id ? { subject_id: String(row.subject_id) } : {}),
    ...(row.amount !== null && row.amount !== undefined ? { amount: Number(row.amount) } : {}),
    ...(row.currency ? { currency: String(row.currency) } : {}),
    properties: (row.properties as Record<string, unknown>) ?? {},
    subject_erased_at: row.subject_erased_at ? new Date(row.subject_erased_at as string).toISOString() : null,
    role: row.subject_id === subjectId && (row.subject_type === subjectType || row.subject_type === null)
      ? ("subject" as const)
      : ("supplier" as const),
  }));
}

/** Every canonical event of a workspace, oldest first — the rollup's input. */
export async function loadRollupEvents(storage: Scoped): Promise<RollupEvent[]> {
  if (storage.backend !== "supabase") {
    return [...(demoEvents.get(storage.workspace.id) ?? [])]
      .filter((event) => (CANONICAL_EVENT_TYPES as readonly string[]).includes(event.type))
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }
  const result = await pool().query(
    `select type, occurred_at, subject_id, amount, currency, properties
       from public.business_events
      where workspace_id = $1::uuid and type = any($2::text[])
      order by occurred_at asc, received_at asc, id asc`,
    [storage.workspace.id, [...CANONICAL_EVENT_TYPES]],
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    type: String(row.type),
    occurred_at: new Date(row.occurred_at as string).toISOString(),
    subject_id: (row.subject_id as string | null) ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    properties: (row.properties as Record<string, unknown>) ?? {},
  }));
}

/* -- rollups ----------------------------------------------------------------- */

/** Swap a workspace's rollups for a fresh computation, atomically. */
export async function replaceRollups(storage: Scoped, rows: readonly MetricRollupRow[]): Promise<void> {
  const computedAt = new Date().toISOString();
  if (storage.backend !== "supabase") {
    demoRollups.set(storage.workspace.id, { rows: [...rows], computed_at: computedAt });
    return;
  }
  pool();
  await withTransaction(async (tx) => {
    await tx.executeSql(`delete from public.business_metric_rollups where workspace_id = $1::uuid`, [storage.workspace.id]);
    // Chunked: a few years of daily rows across ~20 metrics is tens of
    // thousands of rows, too many for one jsonb parameter to be pleasant.
    for (let i = 0; i < rows.length; i += 5_000) {
      await tx.executeSql(
        `insert into public.business_metric_rollups (workspace_id, grain, period_start, metric, dimension, value, computed_at)
         select $1::uuid, t.grain, t.period_start, t.metric, t.dimension, t.value, $3::timestamptz
           from jsonb_to_recordset($2::jsonb) as t(grain text, period_start date, metric text, dimension text, value numeric)`,
        [storage.workspace.id, JSON.stringify(rows.slice(i, i + 5_000)), computedAt],
      );
    }
  });
}

/**
 * One grain of a workspace's rollups, oldest first. `ranges` (inclusive
 * YYYY-MM-DD bounds) keeps a day read to the days it needs: the summary's
 * like-for-like comparison wants three months of days, not years of them.
 */
export async function readRollups(
  storage: Scoped,
  grain: MetricGrain,
  ranges?: ReadonlyArray<{ from: string; to: string }>,
): Promise<{ rows: MetricRollupRow[]; computed_at: string | null }> {
  if (ranges && ranges.length === 0) return { rows: [], computed_at: null };
  if (storage.backend !== "supabase") {
    const stored = demoRollups.get(storage.workspace.id);
    const inRange = (day: string) => !ranges || ranges.some((range) => day >= range.from && day <= range.to);
    return { rows: (stored?.rows ?? []).filter((row) => row.grain === grain && inRange(row.period_start)), computed_at: stored?.computed_at ?? null };
  }
  const result = await pool().query(
    `select grain, to_char(period_start, 'YYYY-MM-DD') as period_start, metric, dimension, value, computed_at
       from public.business_metric_rollups
      where workspace_id = $1::uuid and grain = $2
        and ($3::jsonb is null or exists (
              select 1 from jsonb_to_recordset($3::jsonb) as r("from" date, "to" date)
               where period_start between r."from" and r."to"))
      order by period_start asc`,
    [storage.workspace.id, grain, ranges ? JSON.stringify(ranges) : null],
  );
  let computedAt: string | null = null;
  const rows = (result.rows as Array<Record<string, unknown>>).map((row) => {
    const at = new Date(row.computed_at as string).toISOString();
    if (!computedAt || at > computedAt) computedAt = at;
    return {
      grain: row.grain as MetricGrain,
      period_start: String(row.period_start),
      metric: row.metric as RollupMetric,
      dimension: String(row.dimension ?? ""),
      value: Number(row.value),
    };
  });
  return { rows, computed_at: computedAt };
}

/** Workspaces that have any event: what the nightly rollup walks. */
export async function workspacesWithEvents(): Promise<string[]> {
  if (!hasDatabaseUrl()) return [];
  const result = await getPool().query(`select distinct workspace_id from public.business_events`);
  return (result.rows as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
}
