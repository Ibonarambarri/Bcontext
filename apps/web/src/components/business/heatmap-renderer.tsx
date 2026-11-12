"use client";

/**
 * The `heatmap` renderer: dimension A × dimension B as a grid of cells —
 * the marketplace's "supply vs demand" (zone × week), coloured by bookings
 * per active supplier so the cells where demand outruns supply stand out.
 *
 * The aggregate (dataset rows or business events, grouped by the layout's
 * x/y and measured) is computed by the API on resolve; `heatmapGrid` in the
 * contract lays it out and scales the colour. A cell prints its value and,
 * when the layout has one, the second value under it ("12 / 3"). Plain CSS
 * grid, no chart library: it is a table with colours.
 *
 * What a person sees first: the most recent columns (the scroller opens at
 * its right end — weeks run oldest → newest), rows named after their records
 * (`y_labels`, e.g. a zone's name rather than its code) and labels in the
 * workspace's own words (`renameSides`: "per instructor"). The legend draws
 * the actual colour scale with its two ends (`heatmapLegend`).
 *
 * Read-only. Must not break: an empty pair (no bookings in that zone that
 * week) is drawn empty, not as 0, and every cell has a text label so the
 * colour is never the only carrier of the number.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { HeatmapLayoutSchema, heatmapGrid, type HeatmapViewPayload } from "@bcontext-dev/contract/views/business";
import { formatNumber } from "@bcontext-dev/contract/views/fields";
import { renameSides } from "@bcontext-dev/contract/business/names";
import { bucketLabel, heatColor, heatInk, heatmapLegend } from "@/lib/business/present";
import { useSideNames } from "./business-context";

export function HeatmapRenderer({ payload, layout: rawLayout }: { payload: HeatmapViewPayload; layout: unknown }) {
  const layout = useMemo(() => HeatmapLayoutSchema.safeParse(rawLayout), [rawLayout]);
  const grid = useMemo(() => (layout.success && payload.result ? heatmapGrid(payload.result, layout.data) : null), [layout, payload.result]);
  const names = useSideNames();
  const scroller = useRef<HTMLDivElement | null>(null);

  // Open on the latest weeks: the columns ascend, and last season's are the
  // ones a person scrolls back to, not past.
  const columnCount = grid?.columns.length ?? 0;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [columnCount]);

  if (!layout.success) return <Message>This heatmap’s layout is not valid: {layout.error.issues[0]?.message}</Message>;
  if (!payload.result) return <Message>{payload.error ?? "This heatmap could not be computed."}</Message>;
  if (!grid || grid.rows.length === 0) return <Message>No data yet.</Message>;
  const spec = layout.data;
  const bucket = spec.aggregate.x.bucket ?? null;
  const valueLabel = renameSides(spec.value_label ?? spec.value, names);
  const secondLabel = spec.second ? renameSides(spec.second_label ?? spec.second, names) : null;
  const ratioLabel = spec.color_by === "ratio" && secondLabel ? `${valueLabel} per ${secondLabel.replace(/s$/, "")}` : null;
  const rowName = (row: string) => payload.y_labels?.[row] ?? row;
  const legend = heatmapLegend(grid.domain, ratioLabel ?? valueLabel, spec.high_is, formatNumber);

  return (
    <div className="flex flex-col gap-3">
      <div ref={scroller} className="scroll overflow-x-auto" data-heatmap-scroller>
        <table className="border-separate border-spacing-[3px] text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-[1] bg-[var(--paper)]" />
              {grid.columns.map((column) => (
                <th key={column} scope="col" className="whitespace-nowrap px-1 pb-1 text-center font-medium text-[var(--ink-3)]">
                  {bucketLabel(column, bucket)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={row}>
                <th scope="row" title={rowName(row) !== row ? row : undefined} className="sticky left-0 z-[1] whitespace-nowrap bg-[var(--paper)] pr-2 text-left font-medium text-[var(--ink-2)]">
                  {rowName(row)}
                </th>
                {grid.cells[r]!.map((cell) => {
                  const label = cell.value === null
                    ? `${rowName(row)}, ${bucketLabel(cell.x, bucket)}: no data`
                    : `${rowName(row)}, ${bucketLabel(cell.x, bucket)}: ${formatNumber(cell.value)} ${valueLabel}` +
                      (cell.second !== null && secondLabel ? `, ${formatNumber(cell.second)} ${secondLabel}` : "") +
                      (cell.ratio !== null && ratioLabel ? ` (${formatNumber(cell.ratio)} ${ratioLabel})` : "");
                  return (
                    <td
                      key={cell.x}
                      title={label}
                      aria-label={label}
                      className="h-10 min-w-[52px] rounded-[4px] text-center align-middle leading-tight tabular-nums"
                      style={{ background: heatColor(cell.intensity, spec.high_is), color: heatInk(cell.intensity), border: cell.value === null ? "1px dashed var(--line)" : undefined }}
                    >
                      {cell.value === null ? null : (
                        <>
                          <span className="block font-semibold">{formatNumber(cell.value)}</span>
                          {cell.second !== null ? <span className="block opacity-75">{formatNumber(cell.second)}</span> : null}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1.5 text-[11px] text-[var(--ink-3)]">
        {legend.low !== null ? (
          <div className="flex items-center gap-2" aria-hidden>
            <span className="tabular-nums">{legend.low}</span>
            <span className="h-2 w-32 rounded-full border border-[var(--line)]" style={{ background: legend.gradient }} />
            <span className="tabular-nums">{legend.high}</span>
          </div>
        ) : null}
        <p className="m-0">
          Each cell: {valueLabel}
          {secondLabel ? ` over ${secondLabel}` : ""}. {legend.caption}
          {payload.result.truncated ? " Only the most recent events were read." : ""}
        </p>
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="py-16 text-center text-[12px] text-[var(--ink-3)]">{children}</p>;
}
