/**
 * `/w/<ws>/v/<view>`: every view a workspace has, under one route.
 *
 * `<view>` is either a system surface with a component of its own (the
 * agents and webhooks admin pages) or the slug/id of a saved view, which
 * `ViewCanvas` resolves and renders client-side. The retired `tools` slug
 * redirects to `webhooks`, the part of it that is still here, so bookmarks
 * keep working.
 */
import type { Route } from "next";
import { redirect } from "next/navigation";
import { ViewCanvas } from "@/components/view-canvas";
import { WorkspaceAdminPage, type WorkspaceAdminSurface } from "@/components/agents-dashboard";
import { systemViewPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

const ADMIN_SURFACES = new Set<WorkspaceAdminSurface>(["agents", "webhooks"]);

/** Legacy slugs → where that surface lives now. */
const LEGACY_REDIRECTS: Record<string, (ws: WorkspaceAddress) => Route> = {
  tools: (ws) => systemViewPath(ws, "webhooks"),
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
