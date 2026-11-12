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
 * The card names the current value as the contract does
 * (`current_label` / `current_definition`): a KPI that adds up over a month
 * still running reads "Net (month to date)", so a mid-month net is not
 * mistaken for a loss. The sparkline is about whole months and keeps the
 * plain label. The delta chip's tooltip says what the change compares
 * (`comparison`: "Nov 1–12 vs Oct 1–12" for a flow mid-month).
 *
 * Must not break: `null` prints as "—" and has no delta, never 0.
 */
import { Chip } from "@heroui/react";
import { KPI } from "@/components/ui/kpi";
import type { KpiValue } from "@bcontext-dev/contract/business/metrics";
import { cn } from "@bcontext-dev/contract/utils";
import { comparisonTitle, deltaLabel, formatKpiValue, yoyLabel, type DeltaLabel } from "@/lib/business/format";
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
  const yearOverYear = yoy ? yoyLabel(kpi) : null;
  const delta = yearOverYear ?? deltaLabel(kpi);
  // What the change is against: mid-month, the same days of last month (or
  // of last year) for a flow, never a whole month against a partial one.
  const deltaTitle = delta ? comparisonTitle(kpi, yearOverYear ? "year_ago" : "previous") : null;
  const currentLabel = kpi.current_label ?? kpi.label;
  // A partial month's title says "MTD", small, with the words on hover and
  // for screen readers: "(month to date)" fitted "GMV" but truncated "New
  // customers (month t…" and "Revenue churn (mo…" in a quarter-width card
  // once every flow KPI said it (v0.4.3). Footers and lists, which wrap,
  // keep the words.
  const partial = currentLabel !== kpi.label && currentLabel.startsWith(kpi.label);
  const values = kpi.series.map((point) => point.value);
  return (
    <KPI
      className={cn("min-w-0 rounded-2xl border border-[var(--line)] bg-[var(--paper-2)]", className)}
      title={kpi.current_definition ?? kpi.definition}
    >
      <KPI.Header>
        <KPI.Title className="min-w-0 truncate" aria-label={currentLabel}>
          {partial ? (
            <>
              {kpi.label}{" "}
              <abbr title="month to date" className="text-[0.75em] tracking-wide text-muted no-underline">MTD</abbr>
            </>
          ) : currentLabel}
        </KPI.Title>
        {delta ? (
          <Chip size="sm" variant="soft" color={TONE_COLOR[delta.tone]} className="ml-auto shrink-0" title={deltaTitle ?? undefined}>
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
            <span key={item.key} title={item.current_definition ?? item.definition} className="whitespace-nowrap">
              {item.current_label ?? item.label}{" "}
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
