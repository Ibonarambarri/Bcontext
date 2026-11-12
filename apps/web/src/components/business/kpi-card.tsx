/**
 * One business KPI as a card: the figure, its change, the smaller KPIs that
 * keep it honest, and a 12-month sparkline. Its definition (the contract's
 * one sentence) is the card's tooltip, so the number and its meaning never
 * sit apart.
 *
 * Who uses it: the SaaS-first overview and the `metrics` view renderer
 * (`metrics-renderer.tsx`) — the one KPI card of the web app. Server-safe
 * (no hooks, no chart library: the sparkline is a hand-drawn SVG), so a top
 * row of four costs no JavaScript.
 *
 * Must not break: `null` prints as "—" and has no delta, never 0.
 */
import { Chip } from "@heroui/react";
import { KPI } from "@/components/ui/kpi";
import type { KpiValue } from "@bcontext-dev/contract/business/metrics";
import { cn } from "@bcontext-dev/contract/utils";
import { deltaLabel, formatKpiValue, yoyLabel, type DeltaLabel } from "@/lib/business/format";
import { Sparkline } from "./sparkline";

const TONE_COLOR: Record<DeltaLabel["tone"], "success" | "danger" | "default"> = {
  good: "success",
  bad: "danger",
  flat: "default",
};

export function KpiCard({
  kpi,
  secondary = [],
  currency,
  yoy = false,
  className,
}: {
  kpi: KpiValue;
  secondary?: KpiValue[];
  currency: string;
  /** Compare with a year ago rather than last month. */
  yoy?: boolean;
  className?: string;
}) {
  const delta = yoy ? (yoyLabel(kpi) ?? deltaLabel(kpi)) : deltaLabel(kpi);
  const values = kpi.series.map((point) => point.value);
  return (
    <KPI
      className={cn("min-w-0 rounded-2xl border border-[var(--line)] bg-[var(--paper-2)]", className)}
      title={kpi.definition}
    >
      <KPI.Header>
        <KPI.Title className="truncate">{kpi.label}</KPI.Title>
        {delta ? (
          <Chip size="sm" variant="soft" color={TONE_COLOR[delta.tone]} className="ml-auto shrink-0">
            <Chip.Label className="tabular-nums">{delta.text}</Chip.Label>
          </Chip>
        ) : null}
      </KPI.Header>
      <KPI.Content>
        <span className="kpi__value truncate tabular-nums">{formatKpiValue(kpi.unit, kpi.current, currency)}</span>
        <Sparkline values={values} className="h-8 w-20 text-[var(--accent)]" label={`${kpi.label}, last ${values.length} months`} />
      </KPI.Content>
      {secondary.length > 0 ? (
        <KPI.Footer className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
          {secondary.map((item) => (
            <span key={item.key} title={item.definition} className="whitespace-nowrap">
              {item.label}{" "}
              <span className="font-medium tabular-nums text-foreground">{formatKpiValue(item.unit, item.current, currency)}</span>
            </span>
          ))}
        </KPI.Footer>
      ) : null}
    </KPI>
  );
}

/** A KPI card's footprint while there is nothing to put in it. */
export function KpiCardPlaceholder({ label }: { label: string }) {
  return (
    <KPI className="min-w-0 rounded-2xl border border-dashed border-[var(--line)]">
      <KPI.Header>
        <KPI.Title>{label}</KPI.Title>
      </KPI.Header>
      <KPI.Content>
        <span className="kpi__value text-muted">—</span>
      </KPI.Content>
    </KPI>
  );
}
