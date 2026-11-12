/**
 * `/w/<ws>/v/<view>`: every view a workspace has, under one route.
 *
 * `<view>` is either a system surface with a component of its own (the
 * agents and tools admin pages) or the slug/id of a saved view, which
 * `ViewCanvas` resolves and renders client-side. `webhooks` — the slug the
 * outbound webhooks had while the capability gateway was gone — redirects to
 * `tools`, where they live again, so links from those days keep working.
 */
import type { Route } from "next";
import { redirect } from "next/navigation";
import { ViewCanvas } from "@/components/view-canvas";
import { WorkspaceAdminPage, type WorkspaceAdminSurface } from "@/components/agents-dashboard";
import { systemViewPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

const ADMIN_SURFACES = new Set<WorkspaceAdminSurface>(["agents", "tools"]);

/** Legacy slugs → where that surface lives now. */
const LEGACY_REDIRECTS: Record<string, (ws: WorkspaceAddress) => Route> = {
  webhooks: (ws) => systemViewPath(ws, "tools"),
};

export default async function WorkspaceViewPage({
  params,
}: {
  params: Promise<{ ws: string; view: string }>;
}) {
  const { ws, view } = await params;
  const address = { slug: ws };
  const decoded = decodeURIComponent(view);
  const legacy = LEGACY_REDIRECTS[decoded];
  if (legacy) redirect(legacy(address));
  if (ADMIN_SURFACES.has(decoded as WorkspaceAdminSurface)) {
    return <WorkspaceAdminPage workspace={address} surface={decoded as WorkspaceAdminSurface} />;
  }
  return <ViewCanvas viewSlug={decoded} />;
}
