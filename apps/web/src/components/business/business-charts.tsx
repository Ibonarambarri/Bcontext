"use client";

/**
 * Lazy doors to the business charts (`business-charts-impl.tsx`). Recharts
 * is ~90 KB gzip and the workspace shell's first load has a budget
 * (`scripts/check-performance-budgets.mjs`), so the charts arrive in an
 * async chunk behind a skeleton of the same height — no layout shift.
 *
 * Who uses it: the business overview (server) and the record 360 page.
 */
import dynamic from "next/dynamic";
import { Skeleton } from "@heroui/react";

function ChartSkeleton() {
  return (
    <div role="status" aria-label="Loading chart" className="h-[260px] w-full">
      <Skeleton aria-hidden="true" className="h-full w-full rounded-lg" />
    </div>
  );
}

export const MrrChart = dynamic(() => import("./business-charts-impl").then((m) => m.MrrChart), {
  loading: ChartSkeleton,
});

export const SeasonChart = dynamic(() => import("./business-charts-impl").then((m) => m.SeasonChart), {
  loading: ChartSkeleton,
});
