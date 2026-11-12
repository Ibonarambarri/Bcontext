/**
 * Presentation math for the business renderers — how a chart value prints,
 * the colour of a heatmap cell, a bucket's label — kept out of the
 * components so it is unit-tested without a DOM. KPI cards are
 * `components/business/kpi-card.tsx` (formatting in `./format`).
 *
 * Callers: `components/business/metrics-renderer.tsx`,
 * `components/business/heatmap-renderer.tsx`. Numbers come from the contract
 * (`MetricsSummary`, `heatmapGrid`); nothing here computes a metric, it only
 * decides how one reads. Must not break: a null value prints "—", never 0,
 * and percents are fractions (`PERCENT_IS_FRACTION`).
 */
import type { KpiUnit } from "@bcontext-dev/contract/business/metrics";
import { DISPLAY_LOCALE, formatMoney } from "@bcontext-dev/contract/views/fields";

export const EMPTY_VALUE = "—";

export function formatKpi(value: number | null, unit: KpiUnit | "money" | "count", currency: string, locale: string = DISPLAY_LOCALE): string {
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
export function bucketLabel(period: string, bucket: "day" | "week" | "month" | null | undefined, locale: string = DISPLAY_LOCALE): string {
  if (!bucket || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  const date = Date.parse(`${period}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, bucket === "month"
    ? { month: "short", year: "2-digit", timeZone: "UTC" }
    : { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export interface HeatLegend {
  /** CSS gradient through the same colours the cells use, low → high. */
  gradient: string;
  /** The colouring number at each end, formatted; null when nothing is coloured. */
  low: string | null;
  high: string | null;
  /** One sentence for the caption, in words that hold in light and dark. */
  caption: string;
}

/**
 * The heatmap's legend. The cells mix the hue into the page colour, so a
 * high value is darker on a light page and BRIGHTER on a dark one — "darker
 * is tighter" was only true in one theme. The legend draws the scale itself
 * (a swatch through `heatColor`) and words it as faint → strong, which is
 * true in both.
 */
export function heatmapLegend(
  domain: { min: number; max: number } | null,
  measure: string,
  highIs: "good" | "bad",
  format: (n: number) => string,
): HeatLegend {
  const steps = [0, 0.25, 0.5, 0.75, 1].map((t) => heatColor(t, highIs));
  const strong = highIs === "bad" ? "the strongest colour is where it is tightest" : "the strongest colour is the most";
  return {
    gradient: `linear-gradient(to right, ${steps.join(", ")})`,
    low: domain ? format(domain.min) : null,
    high: domain ? format(domain.max) : null,
    caption: `Colour: ${measure}, faint for the lowest and strong for the highest — ${strong}.`,
  };
}
