/**
 * The metrics summary: the month rollups turned into the KPI set of the
 * workspace's business model — current month, previous month, delta, the
 * same month last year and a 12-month series per KPI. One read, everything
 * the dashboard draws.
 *
 * Callers: `GET /api/workspaces/:ws/metrics/summary` and `data(op=metrics)`
 * over MCP. `buildMetricsSummary` is pure (month rows in, summary out) so it
 * is tested without a database; `getMetricsSummary` loads and calls it.
 *
 * Must not break: a KPI whose inputs are missing is `null`, never 0 — a
 * month before the first event has no MRR, it does not have MRR 0, and a
 * churn rate over zero customers is not 0 %. Percentages are fractions.
 */
import type { BusinessSettings } from "@bcontext-dev/contract/business/record-types";
import {
  KPI_DEFINITIONS,
  METRICS_SERIES_LENGTH,
  kpiSetFor,
  type KpiValue,
  type MetricRollupRow,
  type MetricsSummary,
} from "@bcontext-dev/contract/business/metrics";
import type { Storage } from "@/lib/storage";
import { readRollups } from "./events";
import { getBusinessSettings } from "./record-types";

type MonthMetrics = Map<string, number>;

function shiftMonth(period: string, by: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Every KPI for one month, from that month's rollups and the previous
 * month's (the start-of-month MRR and customer count are the previous
 * month's end values — true by construction of the rollup). `undefined`
 * month = no data for it.
 */
function kpisForMonth(
  set: "saas" | "marketplace",
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
    const burn = expenses === null || revenue === null ? null : Math.max(0, expenses - revenue);
    const cash = get("cash_balance");
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
      burn,
      runway_months: cash === null || burn === null || burn <= 0 ? null : cash / burn,
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

export interface SummaryInput {
  settings: BusinessSettings;
  monthRows: readonly MetricRollupRow[];
  computedAt: string | null;
  /** Defaults to now; decides the current month (UTC). */
  now?: Date;
}

export function buildMetricsSummary(input: SummaryInput): MetricsSummary {
  const now = input.now ?? new Date();
  const currentPeriod = now.toISOString().slice(0, 7);
  const set = kpiSetFor(input.settings.business_model);
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

  if (!set) {
    notes.push("business_model is `product`: no KPI set. Set it to b2b, b2c or marketplace to get one.");
  } else if (months.size === 0) {
    notes.push("no metrics yet: push events to POST /api/workspaces/<ws>/events; the rollup runs within a minute.");
  }

  const kpis: KpiValue[] = [];
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
    const previousPeriod = shiftMonth(currentPeriod, -1);
    const yearAgoPeriod = shiftMonth(currentPeriod, -12);
    for (const definition of KPI_DEFINITIONS[set]) {
      const value = (period: string) => kpisAt(period)[definition.key] ?? null;
      const current = value(currentPeriod);
      const previous = value(previousPeriod);
      const yearAgo = value(yearAgoPeriod);
      kpis.push({
        ...definition,
        current,
        previous,
        delta: current === null || previous === null ? null : current - previous,
        delta_pct: current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous),
        year_ago: yearAgo,
        yoy_delta_pct: current === null || yearAgo === null || yearAgo === 0 ? null : (current - yearAgo) / Math.abs(yearAgo),
        series: Array.from({ length: METRICS_SERIES_LENGTH }, (_, index) => {
          const period = shiftMonth(currentPeriod, index - (METRICS_SERIES_LENGTH - 1));
          return { period, value: value(period) };
        }),
      });
    }
    if (months.has(currentPeriod)) notes.push(`${currentPeriod} is month-to-date.`);
  }

  return {
    business_model: input.settings.business_model,
    kpi_set: set,
    period: "month",
    current_period: currentPeriod,
    currency: input.settings.currency,
    kpis,
    expenses_by_category: expensesByCategory,
    computed_at: input.computedAt,
    notes,
  };
}

export async function getMetricsSummary(storage: Pick<Storage, "backend" | "workspace">): Promise<MetricsSummary> {
  const settings = await getBusinessSettings(storage);
  const { rows, computed_at } = await readRollups(storage, "month");
  return buildMetricsSummary({ settings, monthRows: rows, computedAt: computed_at });
}
