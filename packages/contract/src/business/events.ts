/**
 * Business events — the append-only facts a SaaS app pushes to Bcontext
 * through the ingest API, and the canonical vocabulary the metric rollups
 * understand.
 *
 * Who uses it: `POST /api/workspaces/:ws/events` validates every event with
 * `BusinessEventInputSchema`; the rollup worker reads them back and only acts
 * on `CANONICAL_EVENT_TYPES`; the docs (docs/ingest-api.md) are written from
 * this file.
 *
 * The rule that keeps it small: any type of the right shape is stored, only
 * the canonical ones move a metric, and a canonical type is checked strictly
 * (a `subscription.started` without an amount would be an MRR of nothing,
 * silently). Adding a metric is a code change here and in the rollup, never a
 * migration.
 *
 * Must not break: idempotency (`idempotency_key` unique per workspace, a
 * retry is a no-op) and the meaning of an amount — major units in
 * `currency`, a monthly amount for subscriptions.
 */
import { z } from "zod";
import { CurrencySchema } from "./record-types.js";

export const EXPENSE_CATEGORIES = ["infra", "ai", "tools", "payroll", "marketing", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * The vocabulary the rollups act on, and what each one means.
 *
 *   subscription.started   subject_id = customer, amount = MRR of this
 *                          subscription from now on (monthly, ≥ 0)
 *   subscription.changed   amount = the subscription's NEW MRR (not a delta)
 *   subscription.canceled  the subscription's MRR becomes 0
 *     properties.subscription_id: optional; one subscription per customer
 *     when omitted. A customer's MRR is the sum of their subscriptions.
 *
 *   booking.created        subject_id = buyer, amount = gross booking value,
 *                          properties.booking_id, properties.supplier_id,
 *                          properties.fee = the platform's take (default 0)
 *   booking.completed      properties.booking_id; amount / properties.fee
 *                          optional and, when given, the final values
 *   booking.canceled       properties.booking_id
 *     properties.supplier_id on completed/canceled: optional but
 *     recommended. Without it a supplier's timeline still shows them, joined
 *     on booking_id to the booking.created that names the supplier.
 *
 *   expense.recorded       amount ≥ 0, properties.category (infra | ai | tools
 *                          | payroll | marketing | other), properties.vendor?,
 *                          properties.recurring?
 *   cash.balance           amount = cash on hand at `occurred_at` (the as-of)
 */
export const CANONICAL_EVENT_TYPES = [
  "subscription.started",
  "subscription.changed",
  "subscription.canceled",
  "booking.created",
  "booking.completed",
  "booking.canceled",
  "expense.recorded",
  "cash.balance",
] as const;
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export function isCanonicalEventType(type: string): type is CanonicalEventType {
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(type);
}

/** Same as the DB check (0103): dotted, lowercase. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const EVENT_LIMITS = {
  /** Events per POST. */
  maxBatch: 1_000,
  maxPropertiesBytes: 8_000,
  maxIdLength: 200,
} as const;

const ExternalId = z.string().trim().min(1).max(EVENT_LIMITS.maxIdLength);

const PropertiesSchema = z.record(z.unknown()).refine(
  (value) => JSON.stringify(value).length <= EVENT_LIMITS.maxPropertiesBytes,
  `properties must serialise to at most ${EVENT_LIMITS.maxPropertiesBytes} bytes`,
);

const BaseEventSchema = z.object({
  type: z.string().max(80).regex(EVENT_TYPE_PATTERN, "type must be dotted lowercase, e.g. subscription.started"),
  /** When it happened in the sender's world (ISO 8601 with offset). */
  occurred_at: z.string().datetime({ offset: true }),
  /** The sender's dedupe key: a retry with the same key is acknowledged and not stored again. */
  idempotency_key: ExternalId,
  /** A record type key (`account`, `client`) when the subject is a record. */
  subject_type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
  /** The subject's id in the sender's system (customer, buyer). Never an email. */
  subject_id: ExternalId.optional(),
  amount: z.number().finite().optional(),
  currency: CurrencySchema.optional(),
  properties: PropertiesSchema.optional(),
}).strict();

export type BusinessEventInput = z.infer<typeof BaseEventSchema>;

function requireProp(
  event: BusinessEventInput,
  ctx: z.RefinementCtx,
  key: string,
  kind: "string" | "number" | "boolean",
  required: boolean,
): void {
  const value = event.properties?.[key];
  if (value === undefined || value === null) {
    if (required) ctx.addIssue({ code: "custom", path: ["properties", key], message: `${event.type} needs properties.${key}` });
    return;
  }
  const ok = kind === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === kind;
  if (!ok) ctx.addIssue({ code: "custom", path: ["properties", key], message: `properties.${key} must be a ${kind}` });
}

function requireAmount(event: BusinessEventInput, ctx: z.RefinementCtx, opts: { nonNegative: boolean }): void {
  if (event.amount === undefined) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: `${event.type} needs an amount` });
  } else if (opts.nonNegative && event.amount < 0) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: `${event.type} amount must be ≥ 0` });
  }
  if (event.amount !== undefined && !event.currency) {
    ctx.addIssue({ code: "custom", path: ["currency"], message: "an amount needs its currency" });
  }
}

/**
 * One event, with the canonical types checked strictly. Unknown types pass
 * on shape alone: they are stored for later and ignored by the rollups.
 */
export const BusinessEventInputSchema = BaseEventSchema.superRefine((event, ctx) => {
  if (event.amount !== undefined && !event.currency) {
    ctx.addIssue({ code: "custom", path: ["currency"], message: "an amount needs its currency" });
  }
  switch (event.type) {
    case "subscription.started":
    case "subscription.changed":
      if (!event.subject_id) ctx.addIssue({ code: "custom", path: ["subject_id"], message: `${event.type} needs subject_id (the customer)` });
      requireAmount(event, ctx, { nonNegative: true });
      requireProp(event, ctx, "subscription_id", "string", false);
      break;
    case "subscription.canceled":
      if (!event.subject_id) ctx.addIssue({ code: "custom", path: ["subject_id"], message: `${event.type} needs subject_id (the customer)` });
      requireProp(event, ctx, "subscription_id", "string", false);
      break;
    case "booking.created":
      if (!event.subject_id) ctx.addIssue({ code: "custom", path: ["subject_id"], message: "booking.created needs subject_id (the buyer)" });
      requireAmount(event, ctx, { nonNegative: true });
      requireProp(event, ctx, "booking_id", "string", true);
      requireProp(event, ctx, "supplier_id", "string", true);
      requireProp(event, ctx, "fee", "number", false);
      break;
    case "booking.completed":
      requireProp(event, ctx, "booking_id", "string", true);
      requireProp(event, ctx, "fee", "number", false);
      break;
    case "booking.canceled":
      requireProp(event, ctx, "booking_id", "string", true);
      break;
    case "expense.recorded": {
      requireAmount(event, ctx, { nonNegative: true });
      const category = event.properties?.category;
      if (!(EXPENSE_CATEGORIES as readonly unknown[]).includes(category)) {
        ctx.addIssue({
          code: "custom",
          path: ["properties", "category"],
          message: `expense.recorded needs properties.category: ${EXPENSE_CATEGORIES.join(" | ")}`,
        });
      }
      requireProp(event, ctx, "vendor", "string", false);
      requireProp(event, ctx, "recurring", "boolean", false);
      break;
    }
    case "cash.balance":
      requireAmount(event, ctx, { nonNegative: false });
      break;
  }
});

/** `POST /events`: one event, or `{ events: [...] }`. */
export const BusinessEventsBodySchema = z.union([
  z.object({ events: z.array(z.unknown()).min(1).max(EVENT_LIMITS.maxBatch) }).strict(),
  z.record(z.unknown()),
]);

/** What came back for each event of a batch, in order. */
export type EventIngestStatus = "stored" | "duplicate" | "invalid";

export interface EventIngestResult {
  index: number;
  idempotency_key: string | null;
  status: EventIngestStatus;
  id?: string;
  error?: string;
}

export interface EventsIngestResponse {
  stored: number;
  duplicates: number;
  invalid: number;
  results: EventIngestResult[];
}

/** A stored event, as the API returns it. */
export interface BusinessEvent extends BusinessEventInput {
  id: string;
  workspace_id: string;
  received_at: string;
  properties: Record<string, unknown>;
  subject_erased_at: string | null;
}

/** How many of a subject's events one read returns at most. */
export const SUBJECT_EVENTS_MAX = 200;

/**
 * One event of a subject's timeline. `role` says how the subject is in it:
 * `subject` when the event is about it, `supplier` when it is a booking that
 * names it in `properties.supplier_id` — or a later event of a booking whose
 * `booking.created` named it, matched on `properties.booking_id` (a
 * booking's subject is the buyer, so a supplier's own bookings would
 * otherwise never reach its page).
 */
export interface SubjectEvent extends BusinessEvent {
  role: "subject" | "supplier";
}

/**
 * `GET /api/workspaces/:ws/events?subject_type=&subject_id=&limit=` — one
 * subject's events, newest first: what a record's 360 page draws as its
 * timeline and rebuilds its MRR history from (from `role: "subject"` events
 * only). A read for members (session or `bctx_live_` token); an ingest key
 * cannot read it.
 */
export interface SubjectEventsResponse {
  events: SubjectEvent[];
}
