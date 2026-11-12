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

const COMMON_TAIL: KpiDefinition[] = [
  { key: "expenses", label: "Expenses", unit: "money", higher_is_better: false, definition: "Sum of expense.recorded amounts in the month (reporting currency only).", to_date: `${MONTH_TO_DATE} Expenses booked so far.` },
  { key: "net", label: "Net", unit: "money", higher_is_better: true, definition: "Revenue minus expenses for the month.", to_date: `${MONTH_TO_DATE} Revenue recognised up to today minus every expense booked so far, so it reads low until the month's revenue catches up with bills paid at its start.` },
];

export const KPI_DEFINITIONS: Record<KpiSet, KpiDefinition[]> = {
  saas: [
    { key: "mrr", label: "MRR", unit: "money", higher_is_better: true, definition: "Sum of every active subscription's monthly amount at the end of the month." },
    { key: "mrr_growth", label: "MRR growth", unit: "percent", higher_is_better: true, definition: "MRR change against the previous month's MRR; null when that was 0." },
    { key: "net_new_mrr", label: "Net new MRR", unit: "money", higher_is_better: true, definition: "new + expansion − contraction − churned MRR; equals the month's MRR change." },
    { key: "new_mrr", label: "New MRR", unit: "money", higher_is_better: true, definition: "MRR of customers who had none at the start of the month (first-time or returning)." },
    { key: "expansion_mrr", label: "Expansion MRR", unit: "money", higher_is_better: true, definition: "MRR added by customers whose MRR grew over the month." },
    { key: "contraction_mrr", label: "Contraction MRR", unit: "money", higher_is_better: false, definition: "MRR lost by customers whose MRR shrank but stayed above 0." },
    { key: "churned_mrr", label: "Churned MRR", unit: "money", higher_is_better: false, definition: "MRR of customers who had some at the start of the month and none at its end." },
    { key: "active_customers", label: "Active customers", unit: "count", higher_is_better: true, definition: "Customers with MRR > 0 at the end of the month." },
    { key: "new_customers", label: "New customers", unit: "count", higher_is_better: true, definition: "Customers with MRR 0 at the start of the month and > 0 at its end." },
    { key: "logo_churn_rate", label: "Logo churn", unit: "percent", higher_is_better: false, definition: "Customers lost in the month ÷ active customers at its start; null when there were none." },
    { key: "revenue_churn_rate", label: "Revenue churn", unit: "percent", higher_is_better: false, definition: "(churned + contraction MRR) ÷ MRR at the start of the month (gross); null when that was 0." },
    { key: "nrr", label: "NRR", unit: "percent", higher_is_better: true, definition: "(start MRR + expansion − contraction − churned) ÷ start MRR, monthly; null when start MRR was 0." },
    { key: "arpa", label: "ARPA", unit: "money", higher_is_better: true, definition: "MRR ÷ active customers at the end of the month." },
    ...COMMON_TAIL,
    { key: "burn", label: "Burn", unit: "money", higher_is_better: false, definition: "Expenses minus revenue when positive, else 0 (net burn).", to_date: `${MONTH_TO_DATE} Expenses booked so far minus revenue recognised up to today.` },
    { key: "runway_months", label: "Runway", unit: "months", higher_is_better: true, definition: "Latest cash balance ÷ the month's burn; null without a cash.balance or when burn is 0." },
  ],
  marketplace: [
    { key: "gmv", label: "GMV", unit: "money", higher_is_better: true, definition: "Gross value of bookings created in the month that are not canceled.", to_date: `${MONTH_TO_DATE} Bookings created so far.` },
    { key: "take", label: "Take", unit: "money", higher_is_better: true, definition: "Platform fees of the same bookings — the marketplace's revenue.", to_date: `${MONTH_TO_DATE} Fees of the bookings created so far.` },
    { key: "take_rate", label: "Take rate", unit: "percent", higher_is_better: true, definition: "Take ÷ GMV." },
    { key: "bookings", label: "Bookings", unit: "count", higher_is_better: true, definition: "Bookings created in the month, canceled or not.", to_date: `${MONTH_TO_DATE} Bookings created so far.` },
    { key: "cancellation_rate", label: "Cancellation rate", unit: "percent", higher_is_better: false, definition: "Bookings created in the month that are now canceled ÷ bookings created in the month." },
    { key: "active_suppliers", label: "Active suppliers", unit: "count", higher_is_better: true, definition: "Distinct suppliers with a non-canceled booking created in the month." },
    { key: "active_buyers", label: "Active buyers", unit: "count", higher_is_better: true, definition: "Distinct buyers with a non-canceled booking created in the month." },
    { key: "new_buyers", label: "New buyers", unit: "count", higher_is_better: true, definition: "Active buyers whose first non-canceled booking ever is in the month." },
    { key: "repeat_buyer_rate", label: "Repeat buyers", unit: "percent", higher_is_better: true, definition: "Active buyers with an earlier non-canceled booking ÷ active buyers." },
    ...COMMON_TAIL,
  ],
};

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
  /** Breakdown of the current month's expenses by category. */
  expenses_by_category: Record<string, number>;
  /** When the rollup behind these numbers last ran; null if never. */
  computed_at: string | null;
  notes: string[];
}

/** Percent values are fractions (0.052 = 5.2 %). Said once, here. */
export const PERCENT_IS_FRACTION = true;
