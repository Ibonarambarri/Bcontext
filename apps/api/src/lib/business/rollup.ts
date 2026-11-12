/**
 * The metric rollup: business events in, daily and monthly metric rows out.
 *
 * Who calls it: the `business.rollup` worker job (one workspace, enqueued
 * by the events route with a debounce) and `business.rollup-all` (nightly,
 * every workspace with events, so a lost enqueue costs a day at most).
 *
 * The computation is a pure function (`computeRollups`) over the whole event
 * history of one workspace, and the job replaces every stored row with its
 * output. Recomputing from scratch is the point, not a shortcut: a booking
 * canceled today changes last month's GMV, a late `subscription.changed`
 * changes the MRR of the day it happened, and an incremental rollup would
 * have to know which past periods every event touches. A workspace's events
 * are thousands, not billions; when that stops being true, the function
 * stays and its caller learns to pass a window.
 *
 * Definitions (the contract's `KPI_DEFINITIONS` carries the same sentences):
 *   - Days are UTC. A month is a calendar month; the current one is
 *     month-to-date.
 *   - Money metrics only count events in the workspace's reporting currency;
 *     others are stored and left out (no FX), and counted in `ignored`.
 *   - MRR: a customer's MRR is the sum of their subscriptions' monthly
 *     amounts (`subscription.started|changed` set one, `.canceled` zeroes
 *     it). For a period, each customer's MRR at its start and end decides
 *     the bucket: 0 → >0 new, up expansion, down-but->0 contraction, >0 → 0
 *     churned. So mrr_end = mrr_start + new + expansion − contraction −
 *     churned, exactly, for every period.
 *   - Recognised revenue: SaaS — each day's end-of-day MRR ÷ days in its
 *     month, summed (MRR prorated per day); marketplace — take. net =
 *     revenue − expenses.
 *   - Bookings are counted in the period they were CREATED in, with their
 *     final state: GMV and take only of the ones not canceled since.
 */
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import type { MetricGrain, MetricRollupRow, RollupMetric } from "@bcontext-dev/contract/business/metrics";
import type { RollupEvent } from "./events";

export interface RollupOptions {
  currency: string;
  /** The last day to compute (UTC, YYYY-MM-DD). Defaults to today. */
  today?: string;
  /** Which revenue definition applies; `marketplace` → take, otherwise MRR. */
  businessModel?: BusinessModel;
}

export interface RollupResult {
  rows: MetricRollupRow[];
  /** Canonical events left out because of their currency. */
  ignored: number;
}

const DAY_MS = 86_400_000;

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Per-period accumulator of customer MRR movements. */
class MrrPeriod {
  /** customer → MRR at the start of the period (recorded on first touch). */
  private readonly start = new Map<string, number>();

  touch(customer: string, before: number): void {
    if (!this.start.has(customer)) this.start.set(customer, before);
  }

  /** Classify every touched customer against its end value. */
  close(endOf: (customer: string) => number): Record<"new_mrr" | "expansion_mrr" | "contraction_mrr" | "churned_mrr" | "new_customers" | "churned_customers", number> {
    const out = { new_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churned_mrr: 0, new_customers: 0, churned_customers: 0 };
    for (const [customer, before] of this.start) {
      const after = endOf(customer);
      if (before === 0 && after > 0) {
        out.new_mrr += after;
        out.new_customers += 1;
      } else if (before > 0 && after === 0) {
        out.churned_mrr += before;
        out.churned_customers += 1;
      } else if (after > before) {
        out.expansion_mrr += after - before;
      } else if (after < before) {
        out.contraction_mrr += before - after;
      }
    }
    this.start.clear();
    return out;
  }
}

interface Booking {
  created_day: string;
  buyer: string;
  supplier: string;
  gross: number;
  fee: number;
  canceled: boolean;
}

/**
 * Compute every rollup row for one workspace from its canonical events
 * (any order; ties within a timestamp keep the caller's order).
 */
export function computeRollups(events: readonly RollupEvent[], opts: RollupOptions): RollupResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let ignored = 0;
  const usable = events.filter((event) => {
    if (dayOf(event.occurred_at) > today) return false; // future-dated: not yet
    if (event.currency && event.currency !== opts.currency) {
      ignored++;
      return false;
    }
    return true;
  });
  if (usable.length === 0) return { rows: [], ignored };
  // Time order is the input contract, but a stable sort here costs nothing
  // and makes "the first day" and "the state at the end of a day" true for a
  // caller that forgot it. Ties keep their given order (received order).
  usable.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const hasSubscriptions = usable.some((event) => event.type.startsWith("subscription."));
  const hasBookings = usable.some((event) => event.type.startsWith("booking."));
  const marketplaceRevenue = opts.businessModel === "marketplace" || (!hasSubscriptions && hasBookings);

  // Bookings are cohorted by creation day with their FINAL state, so they are
  // resolved in one pass before the day walk.
  const bookings = new Map<string, Booking>();
  for (const event of usable) {
    const id = str(event.properties.booking_id);
    if (!id) continue;
    if (event.type === "booking.created") {
      const buyer = event.subject_id;
      const supplier = str(event.properties.supplier_id);
      if (!buyer || !supplier) continue;
      bookings.set(id, {
        created_day: dayOf(event.occurred_at),
        buyer,
        supplier,
        gross: event.amount ?? 0,
        fee: num(event.properties.fee) ?? 0,
        canceled: false,
      });
    } else if (event.type === "booking.completed") {
      const booking = bookings.get(id);
      if (!booking) continue;
      if (event.amount !== null) booking.gross = event.amount;
      const fee = num(event.properties.fee);
      if (fee !== null) booking.fee = fee;
    } else if (event.type === "booking.canceled") {
      const booking = bookings.get(id);
      if (booking) booking.canceled = true;
    }
  }
  const bookingsByDay = new Map<string, Booking[]>();
  // A buyer's first non-canceled booking day: "new buyer" in that period.
  const firstBuyDay = new Map<string, string>();
  for (const booking of bookings.values()) {
    const list = bookingsByDay.get(booking.created_day) ?? [];
    list.push(booking);
    bookingsByDay.set(booking.created_day, list);
    if (!booking.canceled) {
      const first = firstBuyDay.get(booking.buyer);
      if (!first || booking.created_day < first) firstBuyDay.set(booking.buyer, booking.created_day);
    }
  }

  const eventsByDay = new Map<string, RollupEvent[]>();
  for (const event of usable) {
    const day = dayOf(event.occurred_at);
    const list = eventsByDay.get(day) ?? [];
    list.push(event);
    eventsByDay.set(day, list);
  }

  const firstDay = [dayOf(usable[0]!.occurred_at), ...[...bookings.values()].map((b) => b.created_day)].sort()[0]!;
  const rows: MetricRollupRow[] = [];
  const push = (grain: MetricGrain, period: string, metric: RollupMetric, value: number, dimension = "") => {
    rows.push({ grain, period_start: period, metric, dimension, value: Math.round(value * 1e6) / 1e6 });
  };

  // SaaS state.
  const subscriptions = new Map<string, { customer: string; mrr: number }>();
  const customerMrr = new Map<string, number>();
  let totalMrr = 0;
  let activeCustomers = 0;
  const dayPeriod = new MrrPeriod();
  const monthPeriod = new MrrPeriod();
  const mrrOf = (customer: string) => customerMrr.get(customer) ?? 0;
  const setSubscription = (key: string, customer: string, mrr: number) => {
    const previous = subscriptions.get(key);
    // A subscription that changes hands is closed on its old customer first.
    if (previous && previous.customer !== customer) setSubscription(key, previous.customer, 0);
    const before = mrrOf(customer);
    dayPeriod.touch(customer, before);
    monthPeriod.touch(customer, before);
    const delta = mrr - (subscriptions.get(key)?.mrr ?? 0);
    if (mrr === 0) subscriptions.delete(key);
    else subscriptions.set(key, { customer, mrr });
    const after = before + delta;
    customerMrr.set(customer, after);
    totalMrr += delta;
    if (before <= 0 && after > 0) activeCustomers++;
    if (before > 0 && after <= 0) activeCustomers--;
  };

  // Month accumulators.
  let month = monthOf(firstDay);
  let monthAcc = freshMonth();
  let lastCash: number | null = null;
  const lifetimeBuyers = new Set<string>();

  for (let day = firstDay; day <= today; day = addDays(day, 1)) {
    if (monthOf(day) !== month) {
      flushMonth(month, monthAcc);
      month = monthOf(day);
      monthAcc = freshMonth();
    }
    let expenses = 0;
    const byCategory = new Map<string, number>();
    for (const event of eventsByDay.get(day) ?? []) {
      switch (event.type) {
        case "subscription.started":
        case "subscription.changed": {
          if (!event.subject_id || event.amount === null) break;
          const key = str(event.properties.subscription_id) ?? event.subject_id;
          setSubscription(key, event.subject_id, Math.max(0, event.amount));
          break;
        }
        case "subscription.canceled": {
          if (!event.subject_id) break;
          const key = str(event.properties.subscription_id) ?? event.subject_id;
          if (subscriptions.has(key)) setSubscription(key, subscriptions.get(key)!.customer, 0);
          break;
        }
        case "expense.recorded": {
          if (event.amount === null) break;
          const category = str(event.properties.category) ?? "other";
          expenses += event.amount;
          byCategory.set(category, (byCategory.get(category) ?? 0) + event.amount);
          break;
        }
        case "cash.balance":
          if (event.amount !== null) lastCash = event.amount;
          break;
      }
    }

    // Marketplace, cohorted by creation day.
    let gmv = 0;
    let take = 0;
    let created = 0;
    let canceled = 0;
    const suppliers = new Set<string>();
    const buyers = new Set<string>();
    for (const booking of bookingsByDay.get(day) ?? []) {
      created++;
      if (booking.canceled) {
        canceled++;
        continue;
      }
      gmv += booking.gross;
      take += booking.fee;
      suppliers.add(booking.supplier);
      buyers.add(booking.buyer);
    }
    const newBuyers = [...buyers].filter((buyer) => firstBuyDay.get(buyer) === day).length;

    const revenue = marketplaceRevenue ? take : totalMrr / daysInMonth(day);
    const moves = dayPeriod.close(mrrOf);

    if (hasSubscriptions) {
      push("day", day, "mrr", totalMrr);
      push("day", day, "active_customers", activeCustomers);
      push("day", day, "new_mrr", moves.new_mrr);
      push("day", day, "expansion_mrr", moves.expansion_mrr);
      push("day", day, "contraction_mrr", moves.contraction_mrr);
      push("day", day, "churned_mrr", moves.churned_mrr);
      push("day", day, "new_customers", moves.new_customers);
      push("day", day, "churned_customers", moves.churned_customers);
    }
    if (hasBookings) {
      push("day", day, "gmv", gmv);
      push("day", day, "take", take);
      push("day", day, "bookings", created);
      push("day", day, "cancellations", canceled);
      push("day", day, "active_suppliers", suppliers.size);
      push("day", day, "active_buyers", buyers.size);
      push("day", day, "new_buyers", newBuyers);
      push("day", day, "repeat_buyers", buyers.size - newBuyers);
    }
    push("day", day, "revenue", revenue);
    push("day", day, "expenses", expenses);
    for (const [category, amount] of byCategory) push("day", day, "expenses_by_category", amount, category);
    push("day", day, "net", revenue - expenses);

    monthAcc.revenue += revenue;
    monthAcc.expenses += expenses;
    for (const [category, amount] of byCategory) monthAcc.byCategory.set(category, (monthAcc.byCategory.get(category) ?? 0) + amount);
    monthAcc.gmv += gmv;
    monthAcc.take += take;
    monthAcc.bookings += created;
    monthAcc.cancellations += canceled;
    for (const s of suppliers) monthAcc.suppliers.add(s);
    for (const b of buyers) monthAcc.buyers.add(b);
  }
  flushMonth(month, monthAcc);
  return { rows, ignored };

  function freshMonth() {
    return {
      revenue: 0,
      expenses: 0,
      byCategory: new Map<string, number>(),
      gmv: 0,
      take: 0,
      bookings: 0,
      cancellations: 0,
      suppliers: new Set<string>(),
      buyers: new Set<string>(),
    };
  }

  function flushMonth(period: string, acc: ReturnType<typeof freshMonth>) {
    if (hasSubscriptions) {
      const moves = monthPeriod.close(mrrOf);
      push("month", period, "mrr", totalMrr);
      push("month", period, "active_customers", activeCustomers);
      push("month", period, "new_mrr", moves.new_mrr);
      push("month", period, "expansion_mrr", moves.expansion_mrr);
      push("month", period, "contraction_mrr", moves.contraction_mrr);
      push("month", period, "churned_mrr", moves.churned_mrr);
      push("month", period, "new_customers", moves.new_customers);
      push("month", period, "churned_customers", moves.churned_customers);
    }
    if (hasBookings) {
      const newBuyers = [...acc.buyers].filter((buyer) => !lifetimeBuyers.has(buyer)).length;
      push("month", period, "gmv", acc.gmv);
      push("month", period, "take", acc.take);
      push("month", period, "bookings", acc.bookings);
      push("month", period, "cancellations", acc.cancellations);
      push("month", period, "active_suppliers", acc.suppliers.size);
      push("month", period, "active_buyers", acc.buyers.size);
      push("month", period, "new_buyers", newBuyers);
      push("month", period, "repeat_buyers", acc.buyers.size - newBuyers);
      for (const buyer of acc.buyers) lifetimeBuyers.add(buyer);
    }
    push("month", period, "revenue", acc.revenue);
    push("month", period, "expenses", acc.expenses);
    for (const [category, amount] of acc.byCategory) push("month", period, "expenses_by_category", amount, category);
    push("month", period, "net", acc.revenue - acc.expenses);
    if (lastCash !== null) push("month", period, "cash_balance", lastCash);
  }
}
