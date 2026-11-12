"use client";

/**
 * The `metrics` renderer: KPI cards and charts for a business workspace.
 *
 * Cards come from the metrics summary (`MetricsSummary`, the same numbers
 * `GET …/metrics/summary` and `data(op=metrics)` return): the value, the delta
 * against the previous month — or the same month last year when the layout
 * says `compare: "year_ago"` (a ski school's February is compared with last
 * February, not with January) — and a 12-month sparkline drawn in plain SVG.
 * The card is the overview's own `KpiCard`, so a KPI reads the same on the
 * dashboard and in a metrics view.
 *
 * Charts are either KPI series from the summary or an aggregate the API ran
 * for this view (dataset rows or business events, bucketed by day/week/month),
 * optionally with the same bucket a year ago as a dashed series. They render
 * with recharts behind `next/dynamic`; the cards never wait for it.
 *
 * Read-only. Must not break: a KPI with no data prints "—" (the summary's
 * null), and a chart whose aggregate failed says why in its own frame
 * instead of taking the page down.
 */
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { Skeleton } from "@heroui/react";
import { MetricsLayoutSchema, aggregateSeries, type MetricsChart as ChartSpec, type MetricsViewPayload } from "@bcontext-dev/contract/views/business";
import type { KpiValue, MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import { cn } from "@bcontext-dev/contract/utils";
import { bucketLabel, formatKpi } from "@/lib/business/present";
import { KpiCard } from "./kpi-card";
import type { ChartSeries } from "./metrics-chart-impl";

const MetricsChart = dynamic(() => import("./metrics-chart-impl").then((m) => m.MetricsChart), {
  loading: () => <Skeleton aria-hidden="true" className="h-[220px] w-full rounded-lg" />,
});

const SERIES_COLORS = ["var(--accent)", "var(--warn)", "var(--ink-3)", "var(--ink)"];

export function MetricsRenderer({ payload, layout: rawLayout }: { payload: MetricsViewPayload; layout: unknown }) {
  const layout = useMemo(() => {
    const parsed = MetricsLayoutSchema.safeParse(rawLayout ?? {});
    return parsed.success ? parsed.data : MetricsLayoutSchema.parse({});
  }, [rawLayout]);
  const summary = payload.summary;
  const cards = useMemo(() => (summary ? pickKpis(summary, layout.kpis) : []), [summary, layout]);

  return (
    <div className="flex flex-col gap-6">
      {summary && summary.kpi_set === null ? (
        <Notice>This workspace’s business model is “product”: there is no KPI set. Pick b2b, b2c or marketplace in the business settings.</Notice>
      ) : null}
      {summary && summary.computed_at === null ? (
        <Notice>No business events have been rolled up yet. Numbers appear once the app sends events to the ingest API.</Notice>
      ) : null}
      {cards.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          {cards.map((kpi) => <KpiCard key={kpi.key} kpi={kpi} currency={summary?.currency ?? "EUR"} yoy={layout.compare === "year_ago"} />)}
        </div>
      ) : null}
      {layout.charts.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {layout.charts.map((chart, index) => (
            <ChartFrame key={`${chart.title}-${index}`} chart={chart} summary={summary} result={payload.charts.find((c) => c.index === index)} />
          ))}
        </div>
      ) : null}
      {summary?.notes.length ? (
        <ul className="m-0 list-none p-0 text-[11px] text-[var(--ink-3)]">
          {summary.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function ChartFrame({ chart, summary, result }: { chart: ChartSpec; summary: MetricsSummary | null; result: MetricsViewPayload["charts"][number] | undefined }) {
  const currency = summary?.currency ?? "EUR";
  const shaped = useMemo(() => shapeChart(chart, summary, result), [chart, summary, result]);
  return (
    <section className="flex flex-col gap-2 rounded-[calc(var(--radius)*1.5)] border border-[var(--line)] bg-[var(--paper)] p-3">
      <h3 className="m-0 text-[12.5px] font-semibold text-[var(--ink)]">{chart.title}</h3>
      {shaped.error ? (
        <p className="py-10 text-center text-[12px] text-[var(--ink-3)]">{shaped.error}</p>
      ) : shaped.rows.length === 0 ? (
        <p className="py-10 text-center text-[12px] text-[var(--ink-3)]">No data yet.</p>
      ) : (
        <MetricsChart type={chart.type} rows={shaped.rows} series={shaped.series} format={(value) => formatKpi(value, chart.unit, currency)} />
      )}
    </section>
  );
}

/** The layout's KPIs in its order, else the whole KPI set. */
function pickKpis(summary: MetricsSummary, keys: readonly string[] | undefined): KpiValue[] {
  if (!keys || keys.length === 0) return summary.kpis;
  const byKey = new Map(summary.kpis.map((kpi) => [kpi.key, kpi]));
  return keys.map((key) => byKey.get(key)).filter((kpi): kpi is KpiValue => Boolean(kpi));
}

/** Rows `{ label, <series>… }` for recharts, from summary series or the view's aggregate. */
export function shapeChart(
  chart: ChartSpec,
  summary: MetricsSummary | null,
  result: MetricsViewPayload["charts"][number] | undefined,
): { rows: Array<Record<string, string | number | null>>; series: ChartSeries[]; error?: string } {
  if (chart.kpis?.length) {
    if (!summary) return { rows: [], series: [], error: "The metrics summary is not available." };
    const kpis = chart.kpis.map((key) => summary.kpis.find((kpi) => kpi.key === key)).filter((kpi) => Boolean(kpi));
    const periods = kpis[0]?.series.map((point) => point.period) ?? [];
    const rows = periods.map((period, i) => {
      const row: Record<string, string | number | null> = { label: bucketLabel(`${period}-01`, "month") };
      for (const kpi of kpis) row[kpi!.key] = kpi!.series[i]?.value ?? null;
      return row;
    });
    return { rows, series: kpis.map((kpi, i) => ({ key: kpi!.key, label: kpi!.label, color: SERIES_COLORS[i % SERIES_COLORS.length]! })) };
  }
  if (!result || !result.result) return { rows: [], series: [], error: result?.error ?? "This chart could not be computed." };
  const measure = chart.measure ?? chart.aggregate!.measures[0]!.as;
  const bucket = chart.aggregate!.x.bucket ?? null;
  const points = aggregateSeries(result.result, measure, bucket);
  const rows = points.map((point) => ({
    label: bucketLabel(point.period, bucket),
    value: point.value,
    ...(chart.yoy ? { year_ago: point.year_ago } : {}),
  }));
  const series: ChartSeries[] = [{ key: "value", label: chart.title.replace(/\s*\(.*\)$/, ""), color: SERIES_COLORS[0]! }];
  if (chart.yoy) series.push({ key: "year_ago", label: "A year earlier", color: "var(--ink-mute)", dashed: true });
  return { rows, series };
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="m-0 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2 text-[12px] text-[var(--ink-3)]">{children}</p>;
}
