/**
 * The metrics summary: the month rollups turned into the KPI set of the
 * workspace's business model — current month, previous month, delta, the
 * same month last year and a 12-month series per KPI. One read, everything
 * the dashboard draws.
 *
 * Callers: `GET /api/workspaces/:ws/metrics/summary` and `data(op=metrics)`
 * over MCP. `buildMetricsSummary` is pure (rollup rows in, summary out) so
 * it is tested without a database; `getMetricsSummary` loads and calls it.
 *
 * Comparisons are like-for-like. While the month runs, a flow KPI (one
 * with `to_date`: expenses, net, GMV, new customers…) is compared with the
 * previous month and the year-ago month cut at the same day, summed from
 * the day rollups; a stock KPI (MRR, active customers, runway) is compared
 * end of month with end of month. Each KPI says which in `comparison`.
 * Runway never divides by the running month's burn (`runwayAt`).
 *
 * Must not break: a KPI whose inputs are missing is `null`, never 0 — a
 * month before the first event has no MRR, it does not have MRR 0, and a
 * churn rate over zero customers is not 0 %. Percentages are fractions.
 */
import type { BusinessSettings } from "@bcontext-dev/contract/business/record-types";
import {
  KPI_DEFINITIONS,
  RUNWAY_BURN_MONTHS,
  comparisonText,
  currentKpiWording,
  isPeriodOpen,
  METRICS_SERIES_LENGTH,
  kpiSetFor,
  type KpiComparison,
  type KpiSet,
  type KpiValue,
  type MetricRollupRow,
  type MetricsSummary,
} from "@bcontext-dev/contract/business/metrics";
import { renameSides, sideNames, type SideNames } from "@bcontext-dev/contract/business/names";
import type { Storage } from "@/lib/storage";
import { readRollups } from "./events";
import { getBusinessSettings, listRecordTypes } from "./record-types";

type MonthMetrics = Map<string, number>;

function shiftMonth(period: string, by: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

function daysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Every KPI for one month — or one month cut at a day (`windowMetrics`) —
 * from its rollups and the previous month's (the start-of-month MRR and
 * customer count are the previous month's end values, true by construction
 * of the rollup). `undefined` month = no data for it. Runway is not here:
 * it needs other months' burn (`runwayAt`).
 */
function kpisForMonth(
  set: KpiSet,
  current: MonthMetrics | undefined,
  previous: MonthMetrics | undefined,
): Record<string, number | null> {
  if (!current) return {};
  const get = (metric: string): number | null => (current.has(metric) ? current.get(metric)! : null);
  // Before the first month with data, MRR and customers were 0, not unknown:
  // a first month's new MRR is all of its MRR.
  const prev = (metric: string): number | null => (previous ? previous.get(metric) ?? null : current.has(metric) ? 0 : null);
  const expenses = get("expenses");
  const revenue = get("revenue");
  const net = get("net");
  if (set === "saas") {
    const mrr = get("mrr");
    const startMrr = prev("mrr");
    const startCustomers = prev("active_customers");
    const newMrr = get("new_mrr");
    const expansion = get("expansion_mrr");
    const contraction = get("contraction_mrr");
    const churned = get("churned_mrr");
    const active = get("active_customers");
    return {
      mrr,
      mrr_growth: mrr === null ? null : ratio(startMrr === null ? null : mrr - startMrr, startMrr),
      net_new_mrr: newMrr === null || expansion === null || contraction === null || churned === null
        ? null
        : newMrr + expansion - contraction - churned,
      new_mrr: newMrr,
      expansion_mrr: expansion,
      contraction_mrr: contraction,
      churned_mrr: churned,
      active_customers: active,
      new_customers: get("new_customers"),
      logo_churn_rate: ratio(get("churned_customers"), startCustomers),
      revenue_churn_rate: churned === null || contraction === null ? null : ratio(churned + contraction, startMrr),
      nrr: startMrr === null || expansion === null || contraction === null || churned === null
        ? null
        : ratio(startMrr + expansion - contraction - churned, startMrr),
      arpa: ratio(mrr, active),
      expenses,
      net,
      burn: expenses === null || revenue === null ? null : Math.max(0, expenses - revenue),
    };
  }
  const gmv = get("gmv");
  const activeBuyers = get("active_buyers");
  return {
    gmv,
    take: get("take"),
    take_rate: ratio(get("take"), gmv),
    bookings: get("bookings"),
    cancellation_rate: ratio(get("cancellations"), get("bookings")),
    active_suppliers: get("active_suppliers"),
    active_buyers: activeBuyers,
    new_buyers: get("new_buyers"),
    repeat_buyer_rate: ratio(get("repeat_buyers"), activeBuyers),
    expenses,
    net,
  };
}

/**
 * Day metrics a window of days adds up: a flow's day row is that day's
 * share of the month (prorated revenue, the day's bookings, the customers
 * who started that day, a buyer's first booking ever), so days 1–N sum to
 * the month cut at N. Stocks are taken at the window's last day. Distinct
 * suppliers and buyers are neither (`UNCUTTABLE`).
 */
const ADDITIVE_DAY_METRICS = new Set([
  "revenue",
  "expenses",
  "net",
  "new_mrr",
  "expansion_mrr",
  "contraction_mrr",
  "churned_mrr",
  "new_customers",
  "churned_customers",
  "gmv",
  "take",
  "bookings",
  "cancellations",
  "new_buyers",
]);
const STOCK_DAY_METRICS = new Set(["mrr", "active_customers"]);
/** Flow KPIs over distinct people: a sum of daily distinct counts is not one. */
const UNCUTTABLE = new Set(["active_suppliers", "active_buyers", "repeat_buyer_rate"]);

/**
 * A month's metrics from its day 1 to day `through` (capped at its
 * length). Undefined when no day of the window has data — before the first
 * event, the window has no figures, not zeros.
 */
function windowMetrics(days: Map<string, MonthMetrics>, period: string, through: number): MonthMetrics | undefined {
  const last = Math.min(through, daysInMonth(period));
  const out: MonthMetrics = new Map();
  let any = false;
  for (let day = 1; day <= last; day++) {
    const row = days.get(`${period}-${String(day).padStart(2, "0")}`);
    if (!row) continue;
    any = true;
    for (const [metric, value] of row) {
      if (ADDITIVE_DAY_METRICS.has(metric)) out.set(metric, (out.get(metric) ?? 0) + value);
      else if (STOCK_DAY_METRICS.has(metric)) out.set(metric, value);
    }
  }
  return any ? out : undefined;
}

export interface SummaryInput {
  settings: BusinessSettings;
  monthRows: readonly MetricRollupRow[];
  /**
   * Day rollups covering the current month, the previous one and the
   * year-ago one (more is fine). Without them a flow KPI mid-month gets no
   * comparison (`none`) rather than a partial-against-full one.
   */
  dayRows?: readonly MetricRollupRow[];
  computedAt: string | null;
  /** Defaults to now; decides the current month (UTC). */
  now?: Date;
  /**
   * The sides the workspace renamed (`sideNames`): "Active suppliers" reads
   * "Active instructors" wherever the summary is shown. Keys never change.
   */
  names?: SideNames;
}

export function buildMetricsSummary(input: SummaryInput): MetricsSummary {
  const now = input.now ?? new Date();
  const currentPeriod = now.toISOString().slice(0, 7);
  const set = kpiSetFor(input.settings.business_model);
  const names = input.names ?? {};
  const notes: string[] = [];

  const months = new Map<string, MonthMetrics>();
  const expensesByCategory: Record<string, number> = {};
  for (const row of input.monthRows) {
    const period = row.period_start.slice(0, 7);
    if (row.metric === "expenses_by_category") {
      if (period === currentPeriod) expensesByCategory[row.dimension] = row.value;
      continue;
    }
    const month = months.get(period) ?? new Map<string, number>();
    month.set(row.metric, row.value);
    months.set(period, month);
  }
  const days = new Map<string, MonthMetrics>();
  for (const row of input.dayRows ?? []) {
    if (row.grain !== "day" || row.dimension !== "") continue;
    const day = days.get(row.period_start) ?? new Map<string, number>();
    day.set(row.metric, row.value);
    days.set(row.period_start, day);
  }

  if (!set) {
    notes.push("business_model is `product`: no KPI set. Set it to b2b, b2c or marketplace to get one.");
  } else if (months.size === 0) {
    notes.push("no metrics yet: push events to POST /api/workspaces/<ws>/events; the rollup runs within a minute.");
  }

  const kpis: KpiValue[] = [];
  let comparisonNote: string | null = null;
  if (set) {
    const perMonth = new Map<string, Record<string, number | null>>();
    const kpisAt = (period: string) => {
      let cached = perMonth.get(period);
      if (!cached) {
        cached = kpisForMonth(set, months.get(period), months.get(shiftMonth(period, -1)));
        perMonth.set(period, cached);
      }
      return cached;
    };
    // Always true today (`current` is this month), but said through
    // `isPeriodOpen` so a summary of a closed month compares whole months.
    const currentOpen = isPeriodOpen(currentPeriod, now);
    const previousPeriod = shiftMonth(currentPeriod, -1);
    const yearAgoPeriod = shiftMonth(currentPeriod, -12);

    // The day the running month's figures reach: the rollup's last day in
    // it (its `today`, which trails `now` until the next run), so both sides
    // of a comparison stop at the same day.
    const lastDay = [...days.keys()].filter((day) => day.startsWith(`${currentPeriod}-`)).sort().at(-1);
    const throughDay = Number((lastDay ?? now.toISOString().slice(0, 10)).slice(8, 10));
    const perWindow = new Map<string, Record<string, number | null>>();
    const windowKpisAt = (period: string) => {
      let cached = perWindow.get(period);
      if (!cached) {
        cached = kpisForMonth(set, windowMetrics(days, period, throughDay), months.get(shiftMonth(period, -1)));
        perWindow.set(period, cached);
      }
      return cached;
    };

    /**
     * Runway at a month: its cash ÷ the mean burn of the last
     * `RUNWAY_BURN_MONTHS` months closed by then — the month itself once it
     * is over, the ones before it while it runs, never a partial month.
     * Months without data are skipped, so a young company averages what it
     * has; a mean burn of 0 (profitable) has no runway to speak of: null.
     */
    const runwayAt = (period: string): number | null => {
      const cash = months.get(period)?.get("cash_balance");
      if (cash === undefined) return null;
      const lastClosed = isPeriodOpen(period, now) ? shiftMonth(period, -1) : period;
      const burns: number[] = [];
      for (let i = 0; i < RUNWAY_BURN_MONTHS; i++) {
        const burn = kpisAt(shiftMonth(lastClosed, -i)).burn;
        if (burn !== null && burn !== undefined) burns.push(burn);
      }
      if (burns.length === 0) return null;
      const average = burns.reduce((sum, burn) => sum + burn, 0) / burns.length;
      return average > 0 ? cash / average : null;
    };

    for (const definition of KPI_DEFINITIONS[set]) {
      const value = (period: string): number | null =>
        definition.key === "runway_months" ? runwayAt(period) : kpisAt(period)[definition.key] ?? null;
      const basis: KpiComparison["basis"] = !currentOpen || !definition.to_date
        ? "full_period"
        : input.dayRows === undefined || UNCUTTABLE.has(definition.key) ? "none" : "same_days";
      const compared = (period: string): number | null => {
        if (basis === "full_period") return value(period);
        if (basis === "none") return null;
        return windowKpisAt(period)[definition.key] ?? null;
      };
      const current = value(currentPeriod);
      const previous = compared(previousPeriod);
      const yearAgo = compared(yearAgoPeriod);
      const label = renameSides(definition.label, names);
      const meaning = renameSides(definition.definition, names);
      const wording = currentKpiWording({ label, definition: meaning, to_date: definition.to_date }, currentOpen);
      kpis.push({
        ...definition,
        label,
        definition: meaning,
        current_label: wording.label,
        current_definition: wording.definition,
        current_is_partial: wording.partial,
        current,
        previous,
        delta: current === null || previous === null ? null : current - previous,
        delta_pct: current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous),
        comparison: {
          basis,
          through_day: basis === "same_days" ? throughDay : null,
          previous_period: previousPeriod,
          year_ago_period: yearAgoPeriod,
        },
        year_ago: yearAgo,
        yoy_delta_pct: current === null || yearAgo === null || yearAgo === 0 ? null : (current - yearAgo) / Math.abs(yearAgo),
        series: Array.from({ length: METRICS_SERIES_LENGTH }, (_, index) => {
          const period = shiftMonth(currentPeriod, index - (METRICS_SERIES_LENGTH - 1));
          return { period, value: value(period) };
        }),
      });
    }
    if (months.has(currentPeriod)) notes.push(`${currentPeriod} is month-to-date.`);
    if (currentOpen) {
      comparisonNote = describeComparisons(kpis);
      notes.push(comparisonNote);
    }
  }

  return {
    business_model: input.settings.business_model,
    kpi_set: set,
    period: "month",
    current_period: currentPeriod,
    currency: input.settings.currency,
    kpis,
    comparison_note: comparisonNote,
    expenses_by_category: expensesByCategory,
    computed_at: input.computedAt,
    notes,
  };
}

/** One sentence per basis in use: what the deltas of a running month mean. */
function describeComparisons(kpis: readonly KpiValue[]): string {
  const parts: string[] = [];
  const sameDays = kpis.find((kpi) => kpi.comparison.basis === "same_days");
  if (sameDays) {
    parts.push(
      `Month-to-date KPIs compare ${comparisonText(sameDays.comparison)}` +
        ` (year over year: ${comparisonText(sameDays.comparison, "year_ago")}).`,
    );
  }
  const stocks = kpis.filter((kpi) => kpi.comparison.basis === "full_period").map((kpi) => kpi.label);
  if (stocks.length > 0) parts.push(`${stocks.join(", ")} compare end of month with end of month.`);
  const none = kpis.filter((kpi) => kpi.comparison.basis === "none").map((kpi) => kpi.label);
  if (none.length > 0) parts.push(`${none.join(", ")}: no like-for-like comparison until the month closes.`);
  return parts.join(" ");
}

export async function getMetricsSummary(storage: Pick<Storage, "backend" | "workspace">): Promise<MetricsSummary> {
  const now = new Date();
  const current = now.toISOString().slice(0, 7);
  const span = (from: string, to: string) => ({ from: `${from}-01`, to: `${to}-${String(daysInMonth(to)).padStart(2, "0")}` });
  const yearAgo = shiftMonth(current, -12);
  const [settings, { rows, computed_at }, { rows: dayRows }, types] = await Promise.all([
    getBusinessSettings(storage),
    readRollups(storage, "month"),
    // Only the days a like-for-like comparison cuts: the year-ago month,
    // the previous one and this one — not years of daily rows.
    readRollups(storage, "day", [span(yearAgo, yearAgo), span(shiftMonth(current, -1), current)]),
    // Only for the words; a failed read keeps the template's.
    listRecordTypes(storage).catch(() => []),
  ]);
  return buildMetricsSummary({ settings, monthRows: rows, dayRows, computedAt: computed_at, now, names: sideNames(types) });
}
