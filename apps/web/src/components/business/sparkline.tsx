/**
 * A tiny trend line in plain SVG, for KPI cards. No chart library: a dozen
 * points do not need one, and the overview's top row should cost no
 * JavaScript at all. Gaps (`null`) break the line rather than dropping to 0.
 *
 * Who uses it: `kpi-card.tsx`. Pure render, server-safe.
 */
import { sparklinePath } from "@/lib/business/sparkline";

export function Sparkline({ values, className, label }: { values: (number | null)[]; className?: string; label: string }) {
  const d = sparklinePath(values, 80, 32);
  if (!d) return <span className={className} aria-hidden="true" />;
  return (
    <svg viewBox="0 0 80 32" preserveAspectRatio="none" className={className} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
