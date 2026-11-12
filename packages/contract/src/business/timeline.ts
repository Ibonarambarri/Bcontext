/**
 * The business timeline of one subject — an account, a customer, a
 * supplier: the events the SaaS app pushed about it, newest first, each with
 * a one-line description a person reads at a glance ("Upgraded to €450/mo").
 *
 * Who uses it: `GET /api/workspaces/:ws/timeline?subject_type=&subject_id=`
 * returns `BusinessTimelineResponse`; the web's account 360 page renders it
 * with `describeBusinessEvent`. Read-only by design: events are facts, they
 * are appended by the ingest API and never edited from the web.
 *
 * Must not break: a supplier's timeline includes the bookings that name it in
 * `properties.supplier_id` (it is never the booking's subject — the buyer
 * is), and an event type nobody described still gets a line (its type).
 */
import type { CanonicalEventType } from "./events.js";

export interface BusinessTimelineEvent {
  id: string;
  type: string;
  occurred_at: string;
  subject_type: string | null;
  subject_id: string | null;
  amount: number | null;
  currency: string | null;
  properties: Record<string, unknown>;
  /** How the subject relates to the event: its subject, or the supplier of a booking. */
  role: "subject" | "supplier";
}

export interface BusinessTimelineResponse {
  subject_type: string | null;
  subject_id: string;
  events: BusinessTimelineEvent[];
  /** True when more events exist than `limit` returned. */
  more: boolean;
}

export const TIMELINE_LIMITS = { defaultLimit: 50, maxLimit: 200 } as const;

function money(amount: number | null, currency: string | null, locale?: string): string {
  if (amount === null) return "";
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const DESCRIBERS: Record<CanonicalEventType, (event: BusinessTimelineEvent, locale?: string) => string> = {
  "subscription.started": (e, l) => `Subscribed${e.amount !== null ? ` at ${money(e.amount, e.currency, l)}/mo` : ""}`,
  "subscription.changed": (e, l) => `Plan changed${e.amount !== null ? ` to ${money(e.amount, e.currency, l)}/mo` : ""}`,
  "subscription.canceled": () => "Subscription canceled",
  "booking.created": (e, l) => (e.role === "supplier" ? "Booked" : "Booking") + (e.amount !== null ? ` · ${money(e.amount, e.currency, l)}` : ""),
  "booking.completed": () => "Booking completed",
  "booking.canceled": () => "Booking canceled",
  "expense.recorded": (e, l) => `Expense${typeof e.properties.vendor === "string" ? ` · ${e.properties.vendor}` : ""}${e.amount !== null ? ` · ${money(e.amount, e.currency, l)}` : ""}`,
  "cash.balance": (e, l) => `Cash balance ${money(e.amount, e.currency, l)}`,
};

/** One line for an event. Unknown types read as their type, so nothing is hidden. */
export function describeBusinessEvent(event: BusinessTimelineEvent, locale?: string): string {
  const describe = (DESCRIBERS as Record<string, ((e: BusinessTimelineEvent, l?: string) => string) | undefined>)[event.type];
  if (describe) return describe(event, locale);
  return event.type + (event.amount !== null ? ` · ${money(event.amount, event.currency, locale)}` : "");
}

/** Whether a move is good news, bad news or neither — the dot colour. */
export function businessEventTone(event: Pick<BusinessTimelineEvent, "type">): "positive" | "negative" | "neutral" {
  if (event.type === "subscription.started" || event.type === "booking.completed") return "positive";
  if (event.type === "subscription.canceled" || event.type === "booking.canceled") return "negative";
  return "neutral";
}
