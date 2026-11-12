/**
 * Which surface draws a saved view once the business layer is in play.
 *
 * `view-canvas.tsx` asks `isBusinessView` before anything loads: a view over
 * record kinds, a dataset-backed type, a `field:` grouping, field filters or
 * the `metrics`/`heatmap` renderers goes to `business-view.tsx`; every other
 * view keeps its existing renderer untouched. Once the resolve payload is in,
 * `businessSurface` picks the component. Pure, so both decisions are tested
 * without a DOM.
 */
import { isCoreKind } from "@bcontext-dev/contract/types";
import { parseFieldRef } from "@bcontext-dev/contract/views/schema";
import { recordBoardField } from "@bcontext-dev/contract/views/fields";
import type { BusinessResolveExtras } from "@bcontext-dev/contract/views/business";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import type { RecordFieldDef } from "@bcontext-dev/contract/business/record-types";

export function isBusinessView(view: Pick<SavedView, "query" | "presentation">): boolean {
  const { query, presentation } = view;
  if (presentation.renderer === "metrics" || presentation.renderer === "heatmap") return true;
  if (query.dataset_type) return true;
  if ((query.field_filters ?? []).length > 0) return true;
  if (parseFieldRef(presentation.group_by)) return true;
  // Only the renderers that have a record form; a graph over accounts stays a graph.
  const recordShaped = presentation.renderer === "board" || presentation.renderer === "table" || presentation.renderer === "list";
  return recordShaped && query.kinds.length > 0 && query.kinds.every((kind) => !isCoreKind(kind));
}

export type BusinessSurface =
  | { kind: "metrics" }
  | { kind: "heatmap" }
  | { kind: "dataset" }
  | { kind: "record-board"; field: RecordFieldDef }
  | { kind: "record-table" }
  | { kind: "message"; text: string };

export function businessSurface(view: Pick<SavedView, "query" | "presentation">, extras: BusinessResolveExtras): BusinessSurface {
  const renderer = view.presentation.renderer;
  if (renderer === "metrics") return extras.metrics ? { kind: "metrics" } : { kind: "message", text: "The metrics for this view are not available." };
  if (renderer === "heatmap") return extras.heatmap ? { kind: "heatmap" } : { kind: "message", text: "The heatmap for this view is not available." };
  if (view.query.dataset_type) {
    return extras.dataset ? { kind: "dataset" } : { kind: "message", text: `No dataset-backed record type \`${view.query.dataset_type}\` here.` };
  }
  if (!extras.records) return { kind: "message", text: "This view has no record types to show." };
  if (renderer === "board") {
    const field = recordBoardField(extras.records.types, view.presentation);
    return field
      ? { kind: "record-board", field }
      : { kind: "message", text: "Group this board by a select field (field:<key>), or give its record type a stage field." };
  }
  return { kind: "record-table" };
}
