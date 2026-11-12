"use client";

/**
 * The recharts half of a metrics view's chart: a line or bar chart of one or
 * more series, with an optional dashed "a year ago" series. Loaded through
 * `next/dynamic` by `metrics-renderer.tsx`, so recharts (~90 KB gzip) stays
 * out of every synchronous bundle — the same split the dashboard's activity
 * chart uses. The caller shapes the rows; this only draws them.
 */
import { BarChart, LineChart } from "@/components/ui/charts";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

export function MetricsChart({
  type,
  rows,
  series,
  format,
  height = 220,
}: {
  type: "line" | "bar";
  rows: Array<Record<string, string | number | null>>;
  series: ChartSeries[];
  format: (value: number) => string;
  height?: number;
}) {
  const tooltip = <LineChart.TooltipContent valueFormatter={(value) => (typeof value === "number" ? format(value) : "—")} />;
  const yAxis = { width: 56, tickFormatter: (value: number) => format(value), allowDecimals: false } as const;
  if (type === "bar") {
    return (
      <BarChart data={rows as Record<string, unknown>[]} height={height}>
        <BarChart.Grid vertical={false} />
        <BarChart.XAxis dataKey="label" tickMargin={8} interval="preserveStartEnd" />
        <BarChart.YAxis {...yAxis} />
        {series.map((s) => (
          <BarChart.Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={s.dashed ? 0.35 : 1} radius={[3, 3, 0, 0]} />
        ))}
        <BarChart.Tooltip content={tooltip} cursor={{ fill: "var(--paper-2)" }} />
      </BarChart>
    );
  }
  return (
    <LineChart data={rows as Record<string, unknown>[]} height={height}>
      <LineChart.Grid vertical={false} />
      <LineChart.XAxis dataKey="label" tickMargin={8} interval="preserveStartEnd" />
      <LineChart.YAxis {...yAxis} />
      {series.map((s) => (
        <LineChart.Line
          key={s.key}
          dataKey={s.key}
          name={s.label}
          stroke={s.color}
          strokeWidth={s.dashed ? 1.5 : 2}
          strokeDasharray={s.dashed ? "4 4" : undefined}
          dot={false}
          connectNulls={false}
          type="monotone"
        />
      ))}
      <LineChart.Tooltip content={tooltip} />
    </LineChart>
  );
}
