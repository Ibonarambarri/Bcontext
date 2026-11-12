/**
 * Which saved views the sidebar lists under "Business".
 *
 * Who uses it: `components/sidebar.tsx`, for a workspace whose business model
 * is not `product`. Pure, tested in `nav.test.ts`.
 *
 * A business template creates its views (Pipeline, Accounts, Renewals,
 * Metrics, Expenses…) as ordinary saved views. What tells them apart from a
 * person's own views is what they show: a view is "business" when its system
 * key says so (`business:` / `business.`), when it renders metrics, or when
 * every kind it queries is a record type rather than a core kind. That keeps
 * the rule working for views a person adds on top of the template's, and
 * needs no list of names here that a template change would silently break.
 *
 * Must not break: a `product` workspace gets no Business section at all, and
 * a view is never listed twice.
 */
import { isCoreKind } from "@bcontext-dev/contract/types";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import type { SavedView } from "@bcontext-dev/contract/views/types";

type ViewLike = Pick<SavedView, "id" | "slug" | "name" | "system_key" | "query" | "presentation"> & { created_at?: string };

export function isBusinessView(view: ViewLike): boolean {
  if (view.system_key && /^business[:.]/.test(view.system_key)) return true;
  if ((view.presentation.renderer as string) === "metrics") return true;
  const kinds = view.query.kinds ?? [];
  return kinds.length > 0 && kinds.every((kind) => !isCoreKind(kind));
}

/**
 * The Business section's entries, in the order the template made them
 * (`created_at`, then name), or none for a product workspace.
 */
export function businessNavViews<T extends ViewLike>(views: readonly T[], model: BusinessModel): T[] {
  if (model === "product") return [];
  const seen = new Set<string>();
  return views
    .filter(isBusinessView)
    .filter((view) => (seen.has(view.id) ? false : (seen.add(view.id), true)))
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.name.localeCompare(b.name));
}
