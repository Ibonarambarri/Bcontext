/**
 * What a workspace's AI calls cost, as the admin API attaches it to the
 * workspaces list and detail (`ai_spend` on each row).
 *
 * The shape mirrors the per-workspace spend the API sums in
 * `src/lib/admin/ai-spend.ts`; it rides on the admin reads outside the
 * contract because it is the operator's own check that the accounting works,
 * read on one screen. Optional and nullable on purpose: an API that predates
 * the column sends nothing, and an API whose ledger could not be read sends
 * `null` — both are "unavailable", never "$0".
 */
import type {
  AdminWorkspaceDetail,
  AdminWorkspaceSummary,
} from "@bcontext-dev/contract/admin-workspaces";

export interface AdminWorkspaceAiSpend {
  /** Every AI call this workspace ever made, in USD. */
  total_usd: number;
  total_events: number;
  last_30d_usd: number;
  last_30d_events: number;
  /**
   * Calls that consumed tokens and were recorded at $0 by the fallback
   * price table — a model the table does not know. Zero is healthy.
   */
  unpriced_events: number;
}

export type WithAiSpend<T> = T & { ai_spend?: AdminWorkspaceAiSpend | null };
export type AdminWorkspaceSummaryWithSpend = WithAiSpend<AdminWorkspaceSummary>;
export type AdminWorkspaceDetailWithSpend = WithAiSpend<AdminWorkspaceDetail>;

/**
 * Dollars as the operator checks them against the gateway's invoice: cents
 * once the figure is a dollar or more, four decimals below that so a month
 * of embeddings reads as $0.0032 rather than $0.00. Fixed locale — the
 * server renders these screens first and the browser must agree.
 */
export function formatUsd(n: number): string {
  const digits = Math.abs(n) >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}
