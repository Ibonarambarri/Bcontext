/**
 * How business numbers are written on screen: money in the workspace's
 * reporting currency, percents (stored as fractions), counts and months, and
 * the sign and colour of a change.
 *
 * Who uses it: every KPI card, chart tooltip and record header in
 * `components/business`. Pure, so the server-rendered overview and its tests
 * format the same way.
 *
 * Must not break: `null` is "not known" and prints as an em dash — never 0.
 * A KPI whose inputs are missing is null in the contract on purpose
 * (`metrics.ts`), and a 0 on screen would be a claim the data never made.
 * The locale is fixed (`en-US`) so the server render and a browser in
 * another language agree, as `panel-ui.tsx` already does for dates.
 */
import { comparisonText, type KpiUnit, type KpiValue } from "@bcontext-dev/contract/business/metrics";
import { DISPLAY_LOCALE, formatMoney as formatMoneyValue } from "@bcontext-dev/contract/views/fields";

const DASH = "—";

/**
 * Money on the dashboard: the contract's one formatter (`formatMoney` in
 * `views/fields`, which tables, boards and timelines use too), with null as
 * a dash. A figure from 10,000 up is compact unless the caller says, so a
 * KPI card stays one line on a phone.
 */
export function formatMoney(value: number | null | undefined, currency: string, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return formatMoneyValue(value, currency, { locale: DISPLAY_LOCALE, compact: opts.compact ?? Math.abs(value) >= 10_000 });
}

/** Fractions: `0.052` → `5.2%`. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: Math.abs(value) >= 100_000 ? "compact" : "standard" }).format(value);
}

export function formatMonths(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value >= 120) return "10y+";
  return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")} mo`;
}

export function formatKpiValue(unit: KpiUnit, value: number | null | undefined, currency: string): string {
  switch (unit) {
    case "money":
      return formatMoney(value, currency);
    case "percent":
      return formatPercent(value);
    case "months":
      return formatMonths(value);
    default:
      return formatCount(value);
  }
}

export type DeltaTone = "good" | "bad" | "flat";

export interface DeltaLabel {
  text: string;
  tone: DeltaTone;
}

/**
 * A KPI's change against the previous month, as one short label. Percents
 * change in points (`+1.2 pts`), because a relative change of a rate is a
 * number nobody can read; counts change in units (`−2`), because "−100%"
 * for two customers fewer is a scare, not a measure; money and months
 * change in percent.
 *
 * What "the previous month" covers is the contract's `comparison` (the same
 * days of last month for a flow while the month runs); `comparisonTitle`
 * words it for the chip's tooltip.
 */
export function deltaLabel(kpi: Pick<KpiValue, "unit" | "delta" | "delta_pct" | "higher_is_better">): DeltaLabel | null {
  if (kpi.unit === "percent") {
    if (kpi.delta === null || !Number.isFinite(kpi.delta)) return null;
    const pts = kpi.delta * 100;
    return { text: `${pts >= 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)} pts`, tone: toneOf(pts, kpi.higher_is_better) };
  }
  if (kpi.unit === "count") return countChange(kpi.delta, kpi.higher_is_better, "");
  if (kpi.delta_pct === null || !Number.isFinite(kpi.delta_pct)) return null;
  const pct = kpi.delta_pct * 100;
  return { text: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`, tone: toneOf(pct, kpi.higher_is_better) };
}

function countChange(delta: number | null, higherIsBetter: boolean, suffix: string): DeltaLabel | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  return {
    text: `${delta >= 0 ? "+" : "−"}${formatCount(Math.abs(delta))}${suffix}`,
    tone: delta === 0 ? "flat" : delta > 0 === higherIsBetter ? "good" : "bad",
  };
}

/**
 * The delta chip's tooltip: what was compared with what ("Change: Nov 1–12
 * vs Oct 1–12"). Null for a summary from an API that did not say.
 */
export function comparisonTitle(kpi: Partial<Pick<KpiValue, "comparison">>, against: "previous" | "year_ago" = "previous"): string | null {
  return kpi.comparison ? `Change: ${comparisonText(kpi.comparison, against)}` : null;
}

/** The same, against a year ago (the marketplace's seasonality). */
export function yoyLabel(kpi: Pick<KpiValue, "unit" | "current" | "year_ago" | "yoy_delta_pct" | "higher_is_better">): DeltaLabel | null {
  if (kpi.unit === "count") {
    return countChange(kpi.current === null || kpi.year_ago === null ? null : kpi.current - kpi.year_ago, kpi.higher_is_better, " YoY");
  }
  if (kpi.yoy_delta_pct === null || !Number.isFinite(kpi.yoy_delta_pct)) return null;
  const pct = kpi.yoy_delta_pct * 100;
  return { text: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}% YoY`, tone: toneOf(pct, kpi.higher_is_better) };
}

function toneOf(change: number, higherIsBetter: boolean): DeltaTone {
  if (Math.abs(change) < 0.05) return "flat";
  return change > 0 === higherIsBetter ? "good" : "bad";
}

/** `2026-11` → `Nov`; with `year`, `Nov 2026`. */
export function periodLabel(period: string, opts: { year?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-US", { month: "short", ...(opts.year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
}
