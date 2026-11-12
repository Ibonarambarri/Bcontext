/**
 * The business renderers' half of the view contract: what a `metrics` or
 * `heatmap` view keeps in `presentation.layout`, the aggregate query both
 * read (a dataset's rows or the workspace's business events, bucketed by
 * date), what `POST /api/views/:id/resolve` returns for them and for record
 * views, and the pure math between the two (bucketing, year-ago alignment,
 * the heatmap grid).
 *
 * Who uses it: the API validates layouts when a view is saved
 * (`businessLayoutIssues`) and computes `AggregateResult`s on resolve
 * (`aggregateRows`); the web renders `MetricsViewPayload` /
 * `HeatmapViewPayload` / `RecordViewPayload` / `DatasetViewPayload` and
 * derives series and grids with the helpers here, so the numbers on screen
 * and the ones an agent reads through `views(op=resolve)` are one
 * computation.
 *
 * Must not break: an empty bucket inside a series is 0 (nothing happened),
 * a bucket outside the data is not invented, and a year-ago value that has
 * no data is null — never 0, which would read as "we had nothing then".
 */
import { z } from "zod";
import type { RecordType } from "../business/record-types.js";
import type { MetricsSummary } from "../business/metrics.js";
import type { RecordRow } from "./fields.js";

/* -------------------------------------------------------------------------- */
/*  The aggregate query                                                       */
/* -------------------------------------------------------------------------- */

export const AGGREGATE_BUCKETS = ["day", "week", "month"] as const;
export type AggregateBucket = (typeof AGGREGATE_BUCKETS)[number];

/** count_distinct is events-only: the dataset query language has no distinct. */
export const AGGREGATE_OPS = ["count", "sum", "count_distinct"] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

/** Column / property names: the dataset DSL's own rule, so a key is never SQL. */
const AggregateKey = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/i, "key must be a column or property name");
const MeasureAlias = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "as must be lowercase letters, digits and _");

export const AggregateSourceSchema = z.discriminatedUnion("from", [
  /** The rows of a dataset-backed record type. */
  z.object({ from: z.literal("dataset"), record_type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) }).strict(),
  /**
   * Business events of the given types. Keys resolve to the event's own
   * columns (`occurred_at`, `subject_id`, `amount`, `type`) and otherwise to
   * `properties.<key>` — `zone`, `supplier_id`.
   */
  z.object({
    from: z.literal("events"),
    types: z.array(z.string().max(80).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)).min(1).max(10),
  }).strict(),
]);
export type AggregateSource = z.infer<typeof AggregateSourceSchema>;

export const AggregateMeasureSchema = z.object({
  as: MeasureAlias,
  op: z.enum(AGGREGATE_OPS),
  /** sum / count_distinct: the column or property. */
  key: AggregateKey.optional(),
}).strict().superRefine((measure, ctx) => {
  if (measure.op !== "count" && !measure.key) {
    ctx.addIssue({ code: "custom", path: ["key"], message: `${measure.op} needs a key` });
  }
});
export type AggregateMeasure = z.infer<typeof AggregateMeasureSchema>;

export const AggregateFilterSchema = z.object({
  key: AggregateKey,
  op: z.enum(["eq", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])).max(50)]),
}).strict();

export const AggregateSpecSchema = z.object({
  source: AggregateSourceSchema,
  /** The first dimension; with `bucket` it is a date truncated to day/week/month. */
  x: z.object({ key: AggregateKey, bucket: z.enum(AGGREGATE_BUCKETS).optional() }).strict(),
  /** The second dimension (heatmap rows). */
  y: z.object({ key: AggregateKey }).strict().nullable().optional(),
  measures: z.array(AggregateMeasureSchema).min(1).max(3),
  where: z.array(AggregateFilterSchema).max(10).optional(),
  /** Only buckets on or after this date (YYYY-MM-DD): a chart of the last 2 years, not of all time. */
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().superRefine((spec, ctx) => {
  const aliases = spec.measures.map((measure) => measure.as);
  if (new Set(aliases).size !== aliases.length) ctx.addIssue({ code: "custom", path: ["measures"], message: "measure aliases must be unique" });
  if (spec.source.from === "dataset" && spec.measures.some((measure) => measure.op === "count_distinct")) {
    ctx.addIssue({ code: "custom", path: ["measures"], message: "count_distinct reads business events; a dataset source takes count and sum" });
  }
});
export type AggregateSpec = z.infer<typeof AggregateSpecSchema>;

export interface AggregateCell {
  x: string;
  y: string | null;
  values: Record<string, number>;
}

export interface AggregateResult {
  /** Distinct x values, ascending (dates sort as ISO strings). */
  x: string[];
  /** Distinct y values by descending total of the first measure; [] without y. */
  y: string[];
  cells: AggregateCell[];
  /** True when the source had more rows than the aggregate could read. */
  truncated: boolean;
}

/** The date a value falls in for a bucket, as YYYY-MM-DD (weeks start Monday, ISO). Null when not a date. */
export function bucketDate(value: unknown, bucket: AggregateBucket): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const raw = value instanceof Date ? value.getTime() : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(raw)) return null;
  const date = new Date(raw);
  if (bucket === "month") return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
  if (bucket === "week") {
    const shift = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - shift);
  }
  return isoDay(date);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dimensionValue(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "(none)";
  return String(raw);
}

function matchesWhere(row: Record<string, unknown>, where: AggregateSpec["where"], read: (row: Record<string, unknown>, key: string) => unknown): boolean {
  for (const filter of where ?? []) {
    const value = read(row, filter.key);
    if (filter.op === "eq" && value !== filter.value) return false;
    if (filter.op === "in" && !(Array.isArray(filter.value) && (filter.value as unknown[]).includes(value as never))) return false;
  }
  return true;
}

export interface AggregateRowsOptions {
  /** How to read a key off a row; default `row[key]`. Events pass a properties-aware reader. */
  read?: (row: Record<string, unknown>, key: string) => unknown;
  /**
   * The rows are already grouped by the dataset query (one per raw x/y with
   * each measure under its alias): re-aggregate by summing the aliases,
   * which is exact for count and sum.
   */
  preAggregated?: boolean;
  truncated?: boolean;
}

/**
 * Group rows by the spec's (bucketed) x and y and compute its measures. Pure:
 * the API feeds it events or the output of a grouped dataset query; tests
 * feed it literals.
 */
export function aggregateRows(rows: readonly Record<string, unknown>[], spec: AggregateSpec, opts: AggregateRowsOptions = {}): AggregateResult {
  const read = opts.read ?? ((row: Record<string, unknown>, key: string) => row[key]);
  const cells = new Map<string, { x: string; y: string | null; sums: Record<string, number>; distinct: Record<string, Set<string>> }>();
  for (const row of rows) {
    if (!opts.preAggregated && !matchesWhere(row, spec.where, read)) continue;
    const rawX = read(row, spec.x.key);
    const x = spec.x.bucket ? bucketDate(rawX, spec.x.bucket) : dimensionValue(rawX);
    if (x === null) continue;
    if (spec.since && spec.x.bucket && x < spec.since) continue;
    const y = spec.y ? dimensionValue(read(row, spec.y.key)) : null;
    const id = `${x}\u0000${y ?? ""}`;
    let cell = cells.get(id);
    if (!cell) {
      cell = { x, y, sums: {}, distinct: {} };
      cells.set(id, cell);
    }
    for (const measure of spec.measures) {
      if (opts.preAggregated) {
        const value = Number(row[measure.as]);
        if (Number.isFinite(value)) cell.sums[measure.as] = (cell.sums[measure.as] ?? 0) + value;
        continue;
      }
      if (measure.op === "count") {
        cell.sums[measure.as] = (cell.sums[measure.as] ?? 0) + 1;
      } else if (measure.op === "sum") {
        const value = Number(read(row, measure.key!));
        if (Number.isFinite(value)) cell.sums[measure.as] = (cell.sums[measure.as] ?? 0) + value;
      } else {
        const value = read(row, measure.key!);
        if (value === null || value === undefined || value === "") continue;
        (cell.distinct[measure.as] ??= new Set()).add(String(value));
      }
    }
  }
  const out: AggregateCell[] = [...cells.values()].map((cell) => ({
    x: cell.x,
    y: cell.y,
    values: Object.fromEntries(spec.measures.map((measure) => [
      measure.as,
      measure.op === "count_distinct" && !opts.preAggregated ? cell.distinct[measure.as]?.size ?? 0 : cell.sums[measure.as] ?? 0,
    ])),
  }));
  const xs = [...new Set(out.map((cell) => cell.x))].sort();
  const first = spec.measures[0]!.as;
  const yTotals = new Map<string, number>();
  for (const cell of out) if (cell.y !== null) yTotals.set(cell.y, (yTotals.get(cell.y) ?? 0) + (cell.values[first] ?? 0));
  const ys = [...yTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([y]) => y);
  out.sort((a, b) => a.x.localeCompare(b.x) || (a.y ?? "").localeCompare(b.y ?? ""));
  return { x: xs, y: ys, cells: out, truncated: Boolean(opts.truncated) };
}

/** Reads an event's own columns first, then `properties.<key>`. */
export function readEventKey(event: Record<string, unknown>, key: string): unknown {
  if (key in event && key !== "properties") return event[key];
  const properties = event.properties;
  return properties && typeof properties === "object" ? (properties as Record<string, unknown>)[key] : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Series                                                                    */
/* -------------------------------------------------------------------------- */

export interface SeriesPoint {
  /** YYYY-MM-DD bucket start (or the raw x without a bucket). */
  period: string;
  value: number;
  /** Same bucket a year earlier; null when the data does not reach back that far. */
  year_ago: number | null;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

function nextBucket(day: string, bucket: AggregateBucket): string {
  if (bucket === "month") {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return isoDay(date);
  }
  return addDays(day, bucket === "week" ? 7 : 1);
}

/**
 * The bucket a year before: the same month, or 52 weeks / 364 days back so a
 * Monday lines up with a Monday — a ski school compares the second week of
 * February with the second week of February, not with a date.
 */
export function yearAgoBucket(day: string, bucket: AggregateBucket): string {
  if (bucket === "month") return `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
  return addDays(day, -364);
}

/**
 * One measure of an aggregate (no y) as a gap-free series, oldest first, with
 * year-ago values. Buckets between the first and last data point that have
 * no row are 0; a year-ago value is null when it falls before the first data
 * point.
 */
export function aggregateSeries(result: AggregateResult, measure: string, bucket: AggregateBucket | null): SeriesPoint[] {
  const byX = new Map<string, number>();
  for (const cell of result.cells) byX.set(cell.x, (byX.get(cell.x) ?? 0) + (cell.values[measure] ?? 0));
  if (!bucket) return result.x.map((x) => ({ period: x, value: byX.get(x) ?? 0, year_ago: null }));
  if (result.x.length === 0) return [];
  const first = result.x[0]!;
  const last = result.x[result.x.length - 1]!;
  const points: SeriesPoint[] = [];
  for (let period = first; period <= last && points.length < 2_000; period = nextBucket(period, bucket)) {
    const ago = yearAgoBucket(period, bucket);
    points.push({ period, value: byX.get(period) ?? 0, year_ago: ago < first ? null : byX.get(ago) ?? 0 });
  }
  return points;
}

/* -------------------------------------------------------------------------- */
/*  Metrics layout                                                            */
/* -------------------------------------------------------------------------- */

export const MetricsChartSchema = z.object({
  title: z.string().trim().min(1).max(80),
  type: z.enum(["line", "bar"]).default("line"),
  /** KPI keys from the metrics summary, one line each (their 12-month series). */
  kpis: z.array(z.string().min(1).max(40)).max(4).optional(),
  /** Or a dataset / events aggregate over a bucketed date (no y). */
  aggregate: AggregateSpecSchema.optional(),
  /** Which measure of the aggregate to plot; default its first. */
  measure: MeasureAlias.optional(),
  /** Overlay the same bucket a year earlier (seasonality). */
  yoy: z.boolean().default(false),
  /** money | count — how values are printed. */
  unit: z.enum(["money", "count"]).default("count"),
}).strict().superRefine((chart, ctx) => {
  if (Boolean(chart.kpis?.length) === Boolean(chart.aggregate)) {
    ctx.addIssue({ code: "custom", message: `chart \`${chart.title}\` takes either kpis or aggregate` });
  }
  if (chart.aggregate && (chart.aggregate.y || !chart.aggregate.x.bucket)) {
    ctx.addIssue({ code: "custom", path: ["aggregate"], message: `chart \`${chart.title}\`: the aggregate needs a bucketed date x and no y` });
  }
});
export type MetricsChart = z.infer<typeof MetricsChartSchema>;

export const MetricsLayoutSchema = z.object({
  /** KPI cards, in order; default every KPI of the workspace's set. */
  kpis: z.array(z.string().min(1).max(40)).max(24).optional(),
  /** What a card's delta compares against. */
  compare: z.enum(["previous", "year_ago"]).default("previous"),
  charts: z.array(MetricsChartSchema).max(8).default([]),
}).strict();
export type MetricsLayout = z.infer<typeof MetricsLayoutSchema>;

/* -------------------------------------------------------------------------- */
/*  Heatmap layout                                                            */
/* -------------------------------------------------------------------------- */

export const HeatmapLayoutSchema = z.object({
  aggregate: AggregateSpecSchema,
  /** The measure printed in a cell. */
  value: MeasureAlias,
  /** An optional second measure printed under it ("bookings / suppliers"). */
  second: MeasureAlias.optional(),
  value_label: z.string().max(40).optional(),
  second_label: z.string().max(40).optional(),
  /**
   * What colours a cell: the value alone, or value ÷ second (demand per
   * supplier). `high_is` says whether a high colour is a problem.
   */
  color_by: z.enum(["value", "ratio"]).default("value"),
  high_is: z.enum(["good", "bad"]).default("good"),
}).strict().superRefine((layout, ctx) => {
  const aliases = new Set(layout.aggregate.measures.map((measure) => measure.as));
  if (!layout.aggregate.y) ctx.addIssue({ code: "custom", path: ["aggregate", "y"], message: "a heatmap needs a second dimension (aggregate.y)" });
  if (!aliases.has(layout.value)) ctx.addIssue({ code: "custom", path: ["value"], message: `value \`${layout.value}\` is not a measure of the aggregate` });
  if (layout.second && !aliases.has(layout.second)) ctx.addIssue({ code: "custom", path: ["second"], message: `second \`${layout.second}\` is not a measure of the aggregate` });
  if (layout.color_by === "ratio" && !layout.second) ctx.addIssue({ code: "custom", path: ["color_by"], message: "color_by=ratio needs a second measure" });
});
export type HeatmapLayout = z.infer<typeof HeatmapLayoutSchema>;

export interface HeatmapCell {
  x: string;
  y: string;
  value: number | null;
  second: number | null;
  /** value ÷ second; null when second is 0 or missing. */
  ratio: number | null;
  /** 0..1 position of the colouring number between the grid's min and max; null for an empty cell. */
  intensity: number | null;
}

export interface HeatmapGrid {
  columns: string[];
  rows: string[];
  /** rows × columns, row-major. */
  cells: HeatmapCell[][];
}

/** The grid a heatmap draws: every y × x pair, empty pairs as nulls, coloured on one scale. */
export function heatmapGrid(result: AggregateResult, layout: Pick<HeatmapLayout, "value" | "second" | "color_by">): HeatmapGrid {
  const index = new Map(result.cells.map((cell) => [`${cell.x}\u0000${cell.y ?? ""}`, cell]));
  const cells = result.y.map((y) => result.x.map((x): HeatmapCell => {
    const cell = index.get(`${x}\u0000${y}`);
    const value = cell ? cell.values[layout.value] ?? 0 : null;
    const second = cell && layout.second ? cell.values[layout.second] ?? 0 : null;
    const ratio = value !== null && second ? value / second : null;
    return { x, y, value, second, ratio, intensity: null };
  }));
  const colour = (cell: HeatmapCell) => (layout.color_by === "ratio" ? cell.ratio : cell.value);
  const numbers = cells.flat().map(colour).filter((n): n is number => n !== null);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  for (const row of cells) {
    for (const cell of row) {
      const n = colour(cell);
      cell.intensity = n === null ? null : max === min ? 1 : (n - min) / (max - min);
    }
  }
  return { columns: result.x, rows: result.y, cells };
}

/* -------------------------------------------------------------------------- */
/*  Layout validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Issues with the business part of a presentation, as messages the API
 * returns verbatim (400). Only `metrics` and `heatmap` carry a layout that
 * must parse; other renderers keep `layout` free-form.
 */
export function businessLayoutIssues(presentation: { renderer: string; layout: Record<string, unknown> }): string[] {
  const check = (key: string, schema: z.ZodTypeAny, required: boolean): string[] => {
    const raw = presentation.layout[key];
    if (raw === undefined) return required ? [`layout.${key} is required for the ${presentation.renderer} renderer`] : [];
    const parsed = schema.safeParse(raw);
    return parsed.success ? [] : parsed.error.issues.map((issue) => `layout.${key}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
  };
  if (presentation.renderer === "metrics") return check("metrics", MetricsLayoutSchema, false);
  if (presentation.renderer === "heatmap") return check("heatmap", HeatmapLayoutSchema, true);
  return [];
}

/** The record types an aggregate layout reads, so the API can check they exist. */
export function layoutDatasetTypes(presentation: { renderer: string; layout: Record<string, unknown> }): string[] {
  const out: string[] = [];
  if (presentation.renderer === "metrics") {
    const parsed = MetricsLayoutSchema.safeParse(presentation.layout.metrics ?? {});
    if (parsed.success) for (const chart of parsed.data.charts) if (chart.aggregate?.source.from === "dataset") out.push(chart.aggregate.source.record_type);
  }
  if (presentation.renderer === "heatmap") {
    const parsed = HeatmapLayoutSchema.safeParse(presentation.layout.heatmap);
    if (parsed.success && parsed.data.aggregate.source.from === "dataset") out.push(parsed.data.aggregate.source.record_type);
  }
  return [...new Set(out)];
}

/* -------------------------------------------------------------------------- */
/*  Resolve payloads                                                          */
/* -------------------------------------------------------------------------- */

/** Node records a board/table/list over record kinds shows. */
export interface RecordViewPayload {
  /** The record types the query names, in its order. */
  types: RecordType[];
  rows: RecordRow[];
  /** The workspace's reporting currency. */
  currency: string;
}

/** Rows of a dataset-backed record type (`query.dataset_type`). */
export interface DatasetViewPayload {
  type: RecordType;
  rows: RecordRow[];
  /** Rows in the dataset; `rows` may be fewer (`truncated`). */
  total: number;
  truncated: boolean;
  /** Node record types a row can be promoted into ("Convert to node"). */
  promote_targets: Array<{ key: string; label: string }>;
}

export interface MetricsChartPayload {
  /** Index into `layout.metrics.charts`. */
  index: number;
  result: AggregateResult | null;
  error?: string;
}

export interface MetricsViewPayload {
  summary: MetricsSummary | null;
  charts: MetricsChartPayload[];
}

export interface HeatmapViewPayload {
  result: AggregateResult | null;
  error?: string;
}

/** What `POST /api/views/:id/resolve` adds for the business renderers. */
export interface BusinessResolveExtras {
  records?: RecordViewPayload;
  dataset?: DatasetViewPayload;
  metrics?: MetricsViewPayload;
  heatmap?: HeatmapViewPayload;
}

/** Rows a dataset view or aggregate reads at most per resolve. */
export const BUSINESS_VIEW_LIMITS = {
  maxDatasetRows: 1_000,
  maxEventsScanned: 200_000,
} as const;
