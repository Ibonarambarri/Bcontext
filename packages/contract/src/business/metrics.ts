/**
 * Business metrics — what the rollup worker stores, which KPIs a workspace
 * gets for its business model, and the shape of the one read the dashboard
 * makes (`GET /api/workspaces/:ws/metrics/summary`, also `data(op=metrics)`
 * over MCP).
 *
 * Who uses it: the API's rollup (`apps/api/src/lib/business/rollup.ts`)
 * writes `ROLLUP_METRICS`; the summary (`.../business/summary.ts`) turns
 * month rows into `MetricsSummary`; the web dashboard (PR4) renders it.
 *
 * Definitions are in `KPI_DEFINITIONS[].definition` — one sentence each, the
 * same sentence the docs carry, so the number and its meaning cannot drift
 * apart. Must not break: a KPI whose inputs are missing is `null`, never 0.
 */
import type { BusinessModel } from "./record-types.js";

export type MetricGrain = "day" | "month";

/** Every metric the rollup writes. `dimension` is '' except where noted. */
export const ROLLUP_METRICS = [
  // SaaS (subscription.*)
  "mrr",
  "new_mrr",
  "expansion_mrr",
  "contraction_mrr",
  "churned_mrr",
  "active_customers",
  "new_customers",
  "churned_customers",
  // Marketplace (booking.*)
  "gmv",
  "take",
  "bookings",
  "cancellations",
  "active_suppliers",
  "active_buyers",
  "new_buyers",
  "repeat_buyers",
  // Every model
  "revenue",
  "expenses",
  /** dimension = expense category */
  "expenses_by_category",
  "net",
  /** month grain only: the latest cash.balance at or before the month's end */
  "cash_balance",
] as const;
export type RollupMetric = (typeof ROLLUP_METRICS)[number];

export interface MetricRollupRow {
  grain: MetricGrain;
  /** YYYY-MM-DD; the first day of the month for `month`. */
  period_start: string;
  metric: RollupMetric;
  dimension: string;
  value: number;
}

/** Which KPI set a business model gets. `product` has none. */
export type KpiSet = "saas" | "marketplace";

export function kpiSetFor(model: BusinessModel): KpiSet | null {
  switch (model) {
    case "b2b":
    case "b2c":
      return "saas";
    case "marketplace":
      return "marketplace";
    default:
      return null;
  }
}

export type KpiUnit = "money" | "count" | "percent" | "months";

export interface KpiDefinition {
  key: string;
  label: string;
  unit: KpiUnit;
  /** Higher is better? Drives the colour of a delta, nothing else. */
  higher_is_better: boolean;
  definition: string;
  /**
   * Set on KPIs that add up over the month (revenue, expenses, GMV…): what
   * the figure means while the month is still running. Their current value
   * is month to date, and a "Net" that is a fortnight's revenue minus the
   * whole month's bills reads like a loss unless it says so
   * (`current_label`).
   *
   * Set means "flow KPI": while its month runs it is compared with the
   * same days of earlier months (`KpiComparison`), not with whole ones.
   * Stock KPIs (MRR, active customers) leave it unset.
   */
  to_date?: string;
}

/** What a partial period's label adds: "Net" → "Net (month to date)". */
export const TO_DATE_SUFFIX = " (month to date)";

/**
 * Is `period` (YYYY-MM) still running at `now`? Its KPIs are then month to
 * date. A closed month is not, whatever its numbers.
 */
export function isPeriodOpen(period: string, now: Date): boolean {
  return now.toISOString().slice(0, 7) <= period;
}

/** The label and definition a KPI's `current` value is shown with. */
export function currentKpiWording(definition: Pick<KpiDefinition, "label" | "definition" | "to_date">, open: boolean): { label: string; definition: string; partial: boolean } {
  if (!open || !definition.to_date) return { label: definition.label, definition: definition.definition, partial: false };
  return { label: definition.label + TO_DATE_SUFFIX, definition: `${definition.definition} ${definition.to_date}`, partial: true };
}

const MONTH_TO_DATE = "This month is not over: the figure is month to date.";
/** The to-date sentence of a KPI that counts something over the month. */
const soFar = (what: string) => `${MONTH_TO_DATE} ${what}`;
/** …and of a rate over the month's flows: it moves until the month closes. */
const RATE_SO_FAR = soFar("The rate of the month so far.");

/** How many closed months the runway's burn is averaged over. */
export const RUNWAY_BURN_MONTHS = 3;

const COMMON_TAIL: KpiDefinition[] = [
  { key: "expenses", label: "Expenses", unit: "money", higher_is_better: false, definition: "Sum of expense.recorded amounts in the month (reporting currency only).", to_date: soFar("Expenses booked so far.") },
  { key: "net", label: "Net", unit: "money", higher_is_better: true, definition: "Revenue minus expenses for the month.", to_date: soFar("Revenue recognised up to today minus every expense booked so far, so it reads low until the month's revenue catches up with bills paid at its start.") },
];

export const KPI_DEFINITIONS: Record<KpiSet, KpiDefinition[]> = {
  saas: [
    { key: "mrr", label: "MRR", unit: "money", higher_is_better: true, definition: "Sum of every active subscription's monthly amount at the end of the month." },
    { key: "mrr_growth", label: "MRR growth", unit: "percent", higher_is_better: true, definition: "MRR change against the previous month's MRR; null when that was 0.", to_date: soFar("MRR today against the end of last month.") },
    { key: "net_new_mrr", label: "Net new MRR", unit: "money", higher_is_better: true, definition: "new + expansion − contraction − churned MRR; equals the month's MRR change.", to_date: soFar("Movements so far.") },
    { key: "new_mrr", label: "New MRR", unit: "money", higher_is_better: true, definition: "MRR of customers who had none at the start of the month (first-time or returning).", to_date: soFar("Movements so far.") },
    { key: "expansion_mrr", label: "Expansion MRR", unit: "money", higher_is_better: true, definition: "MRR added by customers whose MRR grew over the month.", to_date: soFar("Movements so far.") },
    { key: "contraction_mrr", label: "Contraction MRR", unit: "money", higher_is_better: false, definition: "MRR lost by customers whose MRR shrank but stayed above 0.", to_date: soFar("Movements so far.") },
    { key: "churned_mrr", label: "Churned MRR", unit: "money", higher_is_better: false, definition: "MRR of customers who had some at the start of the month and none at its end.", to_date: soFar("Movements so far.") },
    { key: "active_customers", label: "Active customers", unit: "count", higher_is_better: true, definition: "Customers with MRR > 0 at the end of the month." },
    { key: "new_customers", label: "New customers", unit: "count", higher_is_better: true, definition: "Customers with MRR 0 at the start of the month and > 0 at its end.", to_date: soFar("Customers who started so far.") },
    { key: "logo_churn_rate", label: "Logo churn", unit: "percent", higher_is_better: false, definition: "Customers lost in the month ÷ active customers at its start; null when there were none.", to_date: RATE_SO_FAR },
    { key: "revenue_churn_rate", label: "Revenue churn", unit: "percent", higher_is_better: false, definition: "(churned + contraction MRR) ÷ MRR at the start of the month (gross); null when that was 0.", to_date: RATE_SO_FAR },
    { key: "nrr", label: "NRR", unit: "percent", higher_is_better: true, definition: "(start MRR + expansion − contraction − churned) ÷ start MRR, monthly; null when start MRR was 0.", to_date: RATE_SO_FAR },
    { key: "arpa", label: "ARPA", unit: "money", higher_is_better: true, definition: "MRR ÷ active customers at the end of the month." },
    ...COMMON_TAIL,
    { key: "burn", label: "Burn", unit: "money", higher_is_better: false, definition: "Expenses minus revenue when positive, else 0 (net burn).", to_date: soFar("Expenses booked so far minus revenue recognised up to today.") },
    {
      key: "runway_months",
      label: "Runway",
      unit: "months",
      higher_is_better: true,
      // Never the running month's burn: a fortnight's burn against a whole
      // balance read "19 months" for a company with seven.
      definition: `Latest cash balance ÷ the average monthly burn of the last ${RUNWAY_BURN_MONTHS} closed months (fewer when the history is shorter; never the running month); null without a cash.balance or when that burn is 0.`,
    },
  ],
  marketplace: [
    { key: "gmv", label: "GMV", unit: "money", higher_is_better: true, definition: "Gross value of bookings created in the month that are not canceled.", to_date: soFar("Bookings created so far.") },
    { key: "take", label: "Take", unit: "money", higher_is_better: true, definition: "Platform fees of the same bookings — the marketplace's revenue.", to_date: soFar("Fees of the bookings created so far.") },
    { key: "take_rate", label: "Take rate", unit: "percent", higher_is_better: true, definition: "Take ÷ GMV.", to_date: RATE_SO_FAR },
    { key: "bookings", label: "Bookings", unit: "count", higher_is_better: true, definition: "Bookings created in the month, canceled or not.", to_date: soFar("Bookings created so far.") },
    { key: "cancellation_rate", label: "Cancellation rate", unit: "percent", higher_is_better: false, definition: "Bookings created in the month that are now canceled ÷ bookings created in the month.", to_date: RATE_SO_FAR },
    { key: "active_suppliers", label: "Active suppliers", unit: "count", higher_is_better: true, definition: "Distinct suppliers with a non-canceled booking created in the month.", to_date: soFar("Suppliers with a booking so far.") },
    { key: "active_buyers", label: "Active buyers", unit: "count", higher_is_better: true, definition: "Distinct buyers with a non-canceled booking created in the month.", to_date: soFar("Buyers with a booking so far.") },
    { key: "new_buyers", label: "New buyers", unit: "count", higher_is_better: true, definition: "Active buyers whose first non-canceled booking ever is in the month.", to_date: soFar("First bookings so far.") },
    { key: "repeat_buyer_rate", label: "Repeat buyers", unit: "percent", higher_is_better: true, definition: "Active buyers with an earlier non-canceled booking ÷ active buyers.", to_date: RATE_SO_FAR },
    ...COMMON_TAIL,
  ],
};

/**
 * What a KPI's `previous` and `year_ago` were measured over, so a change
 * reads against the right thing:
 *   - `same_days`: a flow KPI (`to_date` set) while its month runs. The
 *     current month to day N is compared with the previous month and the
 *     same month a year ago, each from its day 1 to day N (capped at its
 *     length), summed from the day rollups. A fortnight is never compared
 *     with a whole month.
 *   - `full_period`: a stock KPI (MRR, active customers, ARPA, runway), or
 *     any KPI of a closed month: end of month against end of month.
 *   - `none`: a flow KPI the day rollups cannot cut at day N (distinct
 *     suppliers or buyers: a sum of daily distinct counts is not a distinct
 *     count). No change is shown rather than a partial-against-full one.
 */
export type KpiComparisonBasis = "same_days" | "full_period" | "none";

export interface KpiComparison {
  basis: KpiComparisonBasis;
  /** same_days: the day of the month both sides run to (1–31). */
  through_day: number | null;
  /** YYYY-MM of `previous` and of `year_ago`. */
  previous_period: string;
  year_ago_period: string;
}

/**
 * The comparison in words, for a tooltip or an agent: "Nov 1–12 vs Oct
 * 1–12", "end of Nov vs end of Oct", "no like-for-like comparison yet".
 */
export function comparisonText(comparison: KpiComparison, against: "previous" | "year_ago" = "previous"): string {
  // The current period is the year-ago one, a year on: the comparison carries
  // everything it needs, so a card can word it without the summary.
  const currentPeriod = `${Number(comparison.year_ago_period.slice(0, 4)) + 1}${comparison.year_ago_period.slice(4)}`;
  const other = against === "previous" ? comparison.previous_period : comparison.year_ago_period;
  const name = (period: string) => monthName(period, period.slice(0, 4) !== currentPeriod.slice(0, 4) || against === "year_ago");
  switch (comparison.basis) {
    case "same_days": {
      const day = comparison.through_day ?? 1;
      const span = day === 1 ? " 1" : ` 1–${day}`;
      return `${name(currentPeriod)}${span} vs ${name(other)}${span}`;
    }
    case "full_period":
      return `end of ${name(currentPeriod)} vs end of ${name(other)}`;
    default:
      return "no like-for-like comparison while the month runs";
  }
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthName(period: string, withYear: boolean): string {
  const month = MONTH_NAMES[Number(period.slice(5, 7)) - 1] ?? period;
  return withYear ? `${month} ${period.slice(0, 4)}` : month;
}

export const METRICS_SERIES_LENGTH = 12;

export interface KpiPoint {
  /** YYYY-MM */
  period: string;
  value: number | null;
}

export interface KpiValue extends KpiDefinition {
  current: number | null;
  /**
   * What `current` is called and means: the label and definition, plus
   * "(month to date)" and its explanation when the KPI adds up over a month
   * that is still running (`to_date`). KPI cards show these; charts over
   * the closed months keep `label`. Keys never change.
   */
  current_label: string;
  current_definition: string;
  /** True when `current` covers only part of its period. */
  current_is_partial: boolean;
  previous: number | null;
  /** current − previous; null when either is. For percents, in points. */
  delta: number | null;
  /** (current − previous) ÷ |previous|; null when previous is 0 or null. */
  delta_pct: number | null;
  /**
   * What `previous` and `year_ago` cover (`KpiComparison`): the same days
   * of the earlier month for a flow KPI mid-month, the whole month
   * otherwise. `comparisonText` says it in words.
   */
  comparison: KpiComparison;
  /** The same month a year earlier — seasonality, for the marketplace above all. */
  year_ago: number | null;
  yoy_delta_pct: number | null;
  /** The last 12 months, oldest first, ending at the current period. */
  series: KpiPoint[];
}

export interface MetricsSummary {
  business_model: BusinessModel;
  kpi_set: KpiSet | null;
  period: "month";
  /** YYYY-MM of `current`. */
  current_period: string;
  currency: string;
  kpis: KpiValue[];
  /**
   * The comparison flow KPIs used, in one sentence ("Flow KPIs compare Nov
   * 1–12 with Oct 1–12 …"); null when the current month is closed. It is
   * also in `notes`.
   */
  comparison_note: string | null;
  /** Breakdown of the current month's expenses by category. */
  expenses_by_category: Record<string, number>;
  /** When the rollup behind these numbers last ran; null if never. */
  computed_at: string | null;
  notes: string[];
}

/** Percent values are fractions (0.052 = 5.2 %). Said once, here. */
export const PERCENT_IS_FRACTION = true;
