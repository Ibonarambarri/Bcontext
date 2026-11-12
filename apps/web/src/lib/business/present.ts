/**
 * Presentation math for the business renderers — what a KPI card prints, the
 * sparkline's SVG path, the colour of a heatmap cell — kept out of the
 * components so it is unit-tested without a DOM.
 *
 * Callers: `components/business/metrics-renderer.tsx`,
 * `components/business/heatmap-renderer.tsx`. Numbers come from the contract
 * (`MetricsSummary`, `heatmapGrid`); nothing here computes a metric, it only
 * decides how one reads. Must not break: a null value prints "—", never 0,
 * and percents are fractions (`PERCENT_IS_FRACTION`).
 */
import type { KpiUnit, KpiValue, MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import { formatMoney } from "@bcontext-dev/contract/views/fields";

export const EMPTY_VALUE = "—";

export function formatKpi(value: number | null, unit: KpiUnit | "money" | "count", currency: string, locale?: string): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  switch (unit) {
    case "money":
      return formatMoney(value, currency, locale);
    case "percent":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
    case "months":
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} mo`;
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 }).format(value);
  }
}

export type DeltaTone = "good" | "bad" | "flat";

export interface KpiCardModel {
  key: string;
  label: string;
  definition: string;
  value: string;
  /** "+12.5%" / "+0.8 pts" / null when there is nothing to compare with. */
  delta: string | null;
  tone: DeltaTone;
  /** What the delta compares with, for the caption. */
  against: "previous month" | "same month last year";
  series: Array<number | null>;
}

function signed(text: string, n: number): string {
  return n > 0 ? `+${text}` : text;
}

/**
 * One card from one KPI. Percent KPIs move in points (a churn of 3% → 4% is
 * "+1 pt", not "+33%"); every other unit moves in percent of the previous
 * value. The tone follows `higher_is_better`, so falling churn is good news.
 */
export function kpiCard(kpi: KpiValue, compare: "previous" | "year_ago", currency: string, locale?: string): KpiCardModel {
  const base = compare === "year_ago" ? kpi.year_ago : kpi.previous;
  let delta: string | null = null;
  let direction = 0;
  if (kpi.current !== null && base !== null) {
    const diff = kpi.current - base;
    direction = Math.sign(diff);
    if (kpi.unit === "percent") {
      const pts = diff * 100;
      delta = signed(`${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pts)} pts`, pts);
    } else if (base !== 0) {
      const pct = diff / Math.abs(base);
      delta = signed(new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(pct), pct);
    }
  }
  const tone: DeltaTone = direction === 0 || delta === null ? "flat" : (direction > 0) === kpi.higher_is_better ? "good" : "bad";
  return {
    key: kpi.key,
    label: kpi.label,
    definition: kpi.definition,
    value: formatKpi(kpi.current, kpi.unit, currency, locale),
    delta,
    tone,
    against: compare === "year_ago" ? "same month last year" : "previous month",
    series: kpi.series.map((point) => point.value),
  };
}

/** The cards a metrics view shows: the layout's keys in its order, else the whole KPI set. */
export function kpiCards(summary: MetricsSummary, keys: readonly string[] | undefined, compare: "previous" | "year_ago", locale?: string): KpiCardModel[] {
  const byKey = new Map(summary.kpis.map((kpi) => [kpi.key, kpi]));
  const chosen = keys && keys.length > 0 ? keys.map((key) => byKey.get(key)).filter((kpi): kpi is KpiValue => Boolean(kpi)) : summary.kpis;
  return chosen.map((kpi) => kpiCard(kpi, compare, summary.currency, locale));
}

/**
 * An SVG path for a sparkline in a `width × height` box. Nulls break the
 * line (a month without data is a gap, not a dip to zero); a flat series
 * sits in the middle.
 */
export function sparklinePath(values: ReadonlyArray<number | null>, width: number, height: number, pad = 2): string {
  const numbers = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (numbers.length === 0 || values.length === 0) return "";
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (v: number) => (max === min ? height / 2 : pad + (height - pad * 2) * (1 - (v - min) / (max - min)));
  let path = "";
  let pen = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      pen = false;
      return;
    }
    const x = values.length > 1 ? pad + index * stepX : width / 2;
    path += `${pen ? "L" : "M"}${round(x)} ${round(y(value))}`;
    pen = true;
  });
  return path;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The background of a heatmap cell: the accent (or the warning colour when
 * high is bad) mixed into the paper by intensity. Empty cells stay paper.
 * `color-mix` keeps it on the theme's tokens in light and dark.
 */
export function heatColor(intensity: number | null, highIs: "good" | "bad"): string {
  if (intensity === null) return "transparent";
  const pct = Math.round(8 + intensity * 72);
  const hue = highIs === "bad" ? "var(--warn)" : "var(--accent)";
  return `color-mix(in oklab, ${hue} ${pct}%, var(--paper))`;
}

/** Ink that stays readable on `heatColor` at the same intensity. */
export function heatInk(intensity: number | null): string {
  return intensity !== null && intensity > 0.6 ? "var(--paper)" : "var(--ink)";
}

/** "2026-02-09" → "9 Feb" (week/day buckets) or "Feb 26" (months); other x values pass through. */
export function bucketLabel(period: string, bucket: "day" | "week" | "month" | null | undefined, locale?: string): string {
  if (!bucket || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  const date = Date.parse(`${period}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, bucket === "month"
    ? { month: "short", year: "2-digit", timeZone: "UTC" }
    : { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}
