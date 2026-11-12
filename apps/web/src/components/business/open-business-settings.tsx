"use client";

/**
 * A link-styled button that opens the workspace panel on one of its business
 * sections (ingest keys, record types). The overview is a Server Component;
 * this is its one door into the panel, which lives in the workspace context.
 */
import type { ReactNode } from "react";
import { useWorkspace } from "@/components/workspace-context";
import type { PanelSection } from "@/app/workspaces/workspace-admin/sections";

export function OpenBusinessSettings({ section, children, className }: { section: PanelSection; children: ReactNode; className?: string }) {
  const { openWorkspacePanel } = useWorkspace();
  return (
    <button type="button" onClick={() => openWorkspacePanel(section)} className={className ?? "font-medium text-foreground underline underline-offset-2"}>
      {children}
    </button>
  );
}
