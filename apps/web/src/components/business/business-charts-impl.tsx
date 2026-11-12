"use client";

/**
 * The business overview's two charts, drawn with recharts:
 *   - `MrrChart`: MRR as a line over the last 12 months, with the month's
 *     movements as bars (new and expansion up, contraction and churn down).
 *   - `SeasonChart`: the marketplace's GMV as bars with bookings as a line,
 *     month by month.
 *
 * Only ever loaded through `business-charts.tsx`, which keeps recharts out
 * of the workspace shell's first-load bundle (`perf:budget`). The server
 * page computes the rows (`@/lib/business/overview`) and passes plain data.
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MrrMovementPoint, SeasonPoint } from "@/lib/business/overview";
import { formatCount, formatMoney } from "@/lib/business/format";

const COLORS = {
  line: "var(--accent)",
  new: "var(--color-success, #16a34a)",
  expansion: "color-mix(in oklab, var(--color-success, #16a34a) 55%, transparent)",
  contraction: "color-mix(in oklab, var(--color-danger, #dc2626) 55%, transparent)",
  churn: "var(--color-danger, #dc2626)",
  bars: "color-mix(in oklab, var(--accent) 45%, transparent)",
};

interface TooltipItem {
  name?: string | number;
  dataKey?: unknown;
  value?: unknown;
  color?: string;
  stroke?: string;
  fill?: string;
}

/**
 * The tooltip, formatting each series by what it is: money unless its key
 * is listed as a count. The shared `TooltipContent` takes one formatter for
 * every series, which would print bookings as euros.
 */
function SeriesTooltip({
  active,
  payload,
  label,
  currency,
  countKeys = [],
}: {
  active?: boolean;
  payload?: readonly TooltipItem[];
  label?: string | number;
  currency: string;
  countKeys?: string[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="flex min-w-[160px] flex-col gap-1.5 rounded-[var(--radius)] border border-separator bg-overlay px-3 py-2 shadow-overlay">
      {label !== undefined ? <div className="text-xs font-medium text-muted">{label}</div> : null}
      {payload.map((item, index) => {
        const key = typeof item.dataKey === "string" ? item.dataKey : String(index);
        const value = typeof item.value === "number"
          ? countKeys.includes(key) ? formatCount(item.value) : formatMoney(item.value, currency)
          : "—";
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.stroke || item.fill || item.color }} />
            <span className="flex-1 text-xs text-muted">{item.name}</span>
            <span className="text-xs font-semibold tabular-nums text-foreground">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * MRR as a line, and — when the rows carry any — the month's movements as
 * bars on their own right-hand axis. Rows without movements (a customer's
 * 360 page, which has MRR history only, or a window where nothing moved)
 * draw the line alone: an all-zero bar series made recharts invent a
 * €0–€4 right axis and a legend of four empty series (v0.4.2).
 */
export function MrrChart({ data, currency, height = 260 }: { data: MrrMovementPoint[]; currency: string; height?: number }) {
  const moves = data.some((p) => p.new_mrr !== 0 || p.expansion_mrr !== 0 || p.contraction_mrr !== 0 || p.churned_mrr !== 0);
  const money = (v: number) => formatMoney(v, currency, { compact: true });
  return (
    <div className="bctx-chart w-full">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data as unknown as Record<string, unknown>[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickMargin={8} />
          <YAxis yAxisId="mrr" width={56} tickFormatter={money} />
          {moves ? <YAxis yAxisId="moves" orientation="right" width={56} tickFormatter={money} /> : null}
          {moves ? <ReferenceLine yAxisId="moves" y={0} stroke="var(--line-strong, var(--line))" /> : null}
          {moves ? <Bar yAxisId="moves" dataKey="new_mrr" name="New" stackId="moves" fill={COLORS.new} radius={[2, 2, 0, 0]} /> : null}
          {moves ? <Bar yAxisId="moves" dataKey="expansion_mrr" name="Expansion" stackId="moves" fill={COLORS.expansion} /> : null}
          {moves ? <Bar yAxisId="moves" dataKey="contraction_mrr" name="Contraction" stackId="moves" fill={COLORS.contraction} /> : null}
          {moves ? <Bar yAxisId="moves" dataKey="churned_mrr" name="Churn" stackId="moves" fill={COLORS.churn} radius={[0, 0, 2, 2]} /> : null}
          <Line yAxisId="mrr" dataKey="mrr" name="MRR" type="monotone" stroke={COLORS.line} strokeWidth={2} dot={false} connectNulls={false} />
          {moves ? <Legend iconSize={8} wrapperStyle={{ fontSize: 12 }} /> : null}
          <Tooltip content={<SeriesTooltip currency={currency} />} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SeasonChart({ data, currency, height = 260 }: { data: SeasonPoint[]; currency: string; height?: number }) {
  return (
    <div className="bctx-chart w-full">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data as unknown as Record<string, unknown>[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickMargin={8} />
          <YAxis yAxisId="gmv" width={56} tickFormatter={(v: number) => formatMoney(v, currency, { compact: true })} />
          <YAxis yAxisId="bookings" orientation="right" width={40} allowDecimals={false} />
          <Bar yAxisId="gmv" dataKey="gmv" name="GMV" fill={COLORS.bars} radius={[3, 3, 0, 0]} />
          <Line yAxisId="bookings" dataKey="bookings" name="Bookings" type="monotone" stroke={COLORS.line} strokeWidth={2} dot={false} />
          <Legend iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Tooltip content={<SeriesTooltip currency={currency} countKeys={["bookings"]} />} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
