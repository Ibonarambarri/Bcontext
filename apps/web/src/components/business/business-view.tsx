"use client";

/**
 * The business half of `view-canvas.tsx`: any saved view over record types
 * (board, table, list), a dataset-backed type, or the `metrics` / `heatmap`
 * renderers. `view-canvas` sends a view here when `isBusinessView` says so
 * and loads this module through `next/dynamic`, so none of it weighs on the
 * shell's first paint.
 *
 * Resolves the view once (`POST /api/views/:id/resolve`, which returns the
 * records / dataset rows / metrics / aggregate alongside the node ids) and
 * hands the payload to the surface `businessSurface` picks. Re-resolves when
 * a node changes over realtime (debounced), so an agent moving a deal shows
 * up without a reload. Must not break: the board's own optimistic edits are
 * not overwritten by that refetch mid-flight — the board keeps its state
 * until the view is re-keyed by fresh data.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BoardSkeleton, ViewSkeleton } from "@/components/skeletons";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { resolveBusinessView, type BusinessViewPayload } from "@/lib/business/requests";
import { businessSurface } from "@/lib/business/route-view";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { RecordBoard } from "./record-board";
import { RecordTable } from "./record-table";
import { MetricsRenderer } from "./metrics-renderer";
import { HeatmapRenderer } from "./heatmap-renderer";

export function BusinessView({ workspace, view }: { workspace: WorkspaceAddress; view: SavedView }) {
  const [payload, setPayload] = useState<BusinessViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    const loaded = await resolveBusinessView(workspace, view.id);
    if (loaded.ok) {
      setPayload(loaded.data);
      setError(null);
      setGeneration((n) => n + 1);
    } else {
      setError(loaded.status === 404 ? "This view does not exist or is not shared with you." : loaded.message);
    }
  }, [workspace, view.id]);

  useEffect(() => {
    void load();
  }, [load, view.version]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resync = useCallback(() => {
    if (debounce.current) return;
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void load();
    }, 400);
  }, [load]);
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);
  useWorkspaceBroadcast("node.created", resync);
  useWorkspaceBroadcast("node.deleted", resync);
  // An edit from elsewhere (an agent) moves a card; a record board's own
  // drag also echoes here, which re-keys it onto the server's truth.
  useWorkspaceBroadcast("node.updated", resync);

  if (error && !payload) return <Message>{error}</Message>;
  if (!payload) return view.presentation.renderer === "board" ? <Frame><BoardSkeleton /></Frame> : <ViewSkeleton />;

  const current = { query: payload.view.query, presentation: payload.view.presentation };
  const surface = businessSurface(current, payload);
  switch (surface.kind) {
    case "metrics":
      return <Frame><MetricsRenderer payload={payload.metrics!} layout={current.presentation.layout.metrics} /></Frame>;
    case "heatmap":
      return <Frame><HeatmapRenderer payload={payload.heatmap!} layout={current.presentation.layout.heatmap} /></Frame>;
    case "dataset":
      return <Frame><RecordTable key={generation} workspace={workspace} source={{ kind: "dataset", payload: payload.dataset! }} presentation={current.presentation} /></Frame>;
    case "record-board":
      return <Frame><RecordBoard key={generation} workspace={workspace} payload={payload.records!} field={surface.field} presentation={current.presentation} /></Frame>;
    case "record-table":
      return <Frame><RecordTable key={generation} workspace={workspace} source={{ kind: "records", payload: payload.records! }} presentation={current.presentation} /></Frame>;
    default:
      return <Message>{surface.text}</Message>;
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-none px-6 pb-7 pt-3 sm:px-10">{children}</div>
    </section>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[var(--ink-3)]">{children}</div>;
}
