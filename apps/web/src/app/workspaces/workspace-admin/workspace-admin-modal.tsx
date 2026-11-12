"use client";

/**
 * Administering one workspace: its name and colour, its members, the
 * invitations still open and what it consumes this month.
 *
 * Opened from two places, and the same component in both: the hub
 * (`workspaces-view.tsx`, the gear on a card, URL-driven through
 * `?ws=<slug>&section=`) and the workspace itself (`workspace-shell.tsx`,
 * from the settings dialog and the account menu), so a person never has to
 * leave the workspace they are in to let somebody into it. It reads and
 * writes only through `/api/workspaces/<slug>/…`; the API decides who may
 * do what and this panel only draws what it was told (`can_manage`).
 *
 * A centred dialog rather than a drawer: an administrator is doing a piece
 * of work with the roster, not glancing at a sidebar of the page behind
 * them, and a route would lose the place they came from.
 *
 * The rail is the product's own `Sidebar`, the one the workspace and the
 * platform panel already navigate with, so the third place you move around
 * inside Bcontext works like the other two. It is built for a page
 * (`height: 100svh`, a provider at least as tall), which is why
 * `.workspace-panel` in `globals.css` undoes exactly those page-sized rules
 * and nothing else.
 *
 * Everything is read when it opens and re-read after every write, so no two
 * sections can disagree about who is in the workspace — a roster and an
 * invitation list that have drifted apart are worse than a spinner.
 *
 * Must not break: a member who cannot manage the workspace still opens it
 * (General says what their role allows, Members is a read-only roster); the
 * Invitations and Usage sections only appear for those who manage it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Mail, Settings2, Users, X } from "lucide-react";
import { Modal, Skeleton } from "@heroui/react";
import { Sidebar as SidebarPrimitive } from "@/components/ui/sidebar";
import { gradientCss, gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import type {
  WorkspaceMembersResponse,
  WorkspaceRole,
  WorkspaceUsage,
} from "@bcontext-dev/contract/workspaces";
import { workspaceApiRef } from "@/web/workspace-url";
import type { PanelSection } from "./sections";
import { GeneralSection } from "./general-section";
import { MembersSection } from "./members-section";
import { InvitationsSection } from "./invitations-section";
import { UsageSection } from "./usage-section";

/** What the host already knows about the workspace, so the header paints at once. */
export interface PanelWorkspace {
  slug: string;
  name: string;
  metadata: Record<string, unknown> | null;
  /** The caller's role, until the roster read says whether they manage it. */
  role: WorkspaceRole;
}

interface RailItem {
  id: PanelSection;
  label: string;
  icon: typeof Settings2;
  /** Only shown to someone who manages the workspace. */
  manageOnly?: boolean;
}

/** Grouped, because the sections are not siblings: the workspace itself, and the people in it. */
const GROUPS: ReadonlyArray<{ label: string; items: readonly RailItem[] }> = [
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General", icon: Settings2 },
      { id: "usage", label: "Usage", icon: Gauge, manageOnly: true },
    ],
  },
  {
    label: "People",
    items: [
      { id: "members", label: "Members", icon: Users },
      { id: "invitations", label: "Invitations", icon: Mail, manageOnly: true },
    ],
  },
];

export function WorkspaceAdminModal({
  workspace,
  initialSection = "general",
  onClose,
}: {
  workspace: PanelWorkspace;
  initialSection?: PanelSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<PanelSection>(initialSection);
  const [name, setName] = useState(workspace.name);
  const [metadata, setMetadata] = useState(workspace.metadata);
  const [roster, setRoster] = useState<WorkspaceMembersResponse | null>(null);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/workspaces/${encodeURIComponent(workspaceApiRef(workspace.slug))}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [membersRes, usageRes] = await Promise.all([
        fetch(`${base}/members`, { cache: "no-store" }),
        fetch(`${base}/usage`, { cache: "no-store" }),
      ]);
      if (!membersRes.ok) {
        const body = (await membersRes.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(body?.message ?? "Couldn't load this workspace.");
        return;
      }
      setRoster((await membersRes.json()) as WorkspaceMembersResponse);
      // Usage is an extra: a workspace whose counters cannot be read still
      // has a roster to administer, and a section that cannot load says so
      // where it lives rather than blanking the panel. A member who does not
      // manage the workspace is refused it, and never sees the section.
      if (usageRes.ok) {
        setUsage((await usageRes.json()) as WorkspaceUsage);
        setUsageError(false);
      } else {
        setUsage(null);
        setUsageError(true);
      }
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // Before the roster lands, the role the host passed decides: owners and
  // admins manage a workspace. After, the API's answer does.
  const canManage =
    roster?.can_manage ?? (workspace.role === "owner" || workspace.role === "admin");
  const role = roster?.role ?? workspace.role;

  // A section the person cannot use is not offered, and a link that named
  // one (`?section=invitations` for a viewer) falls back to General.
  const shown = canManage || (section !== "invitations" && section !== "usage") ? section : "general";

  const counts = useMemo<Partial<Record<PanelSection, number>>>(
    () => ({
      members: roster?.members.length,
      invitations: roster?.invites.length || undefined,
    }),
    [roster],
  );

  const gradient = gradientFor({ slug: workspace.slug, metadata });

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="backdrop-blur-[6px]"
      style={{ background: "var(--ov-backdrop, rgba(0,0,0,0.55))" }}
    >
      <Modal.Container placement="center" className="p-4">
        <Modal.Dialog
          aria-label={`Manage ${name}`}
          className="workspace-panel relative flex h-[86dvh] max-h-[760px] w-full max-w-[1060px] overflow-hidden border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.55)]"
        >
          <Modal.CloseTrigger
            aria-label="Close (Esc)"
            className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <X size={14} />
          </Modal.CloseTrigger>

          {/* No collapsing and no `mod+b`: inside a dialog a rail that can be
              folded away is a control with nowhere to go, and the shortcut
              belongs to the workspace sidebar behind this one. The provider
              is told to grow because `.modal__dialog` is a column flex
              container and, while loading, its content is a short skeleton. */}
          <SidebarPrimitive.Provider
            collapsible="none"
            toggleShortcut={false}
            className="min-h-0 w-full flex-1 flex-col md:flex-row"
            style={{ "--sidebar-width": "232px" } as React.CSSProperties}
          >
            <SidebarPrimitive className="max-h-[34%] shrink-0 border-b md:max-h-none md:border-b-0 md:border-r">
              <SidebarPrimitive.Header className="px-3 pt-3">
                <div className="flex min-w-0 items-center gap-2.5 pr-8">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[15px] font-semibold leading-none text-white"
                    style={{ background: gradientCss(gradient), textShadow: "0 1px 1px rgba(0,0,0,.2)" }}
                  >
                    {(name[0] ?? "·").toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                      {name}
                    </div>
                    <div className="mt-0.5 text-[11.5px] capitalize leading-tight text-muted">
                      {role}
                    </div>
                  </div>
                </div>
              </SidebarPrimitive.Header>

              <SidebarPrimitive.Content>
                <nav aria-label="Workspace sections" className="scroll flex-1 overflow-y-auto px-1 pb-3">
                  {GROUPS.map((group) => {
                    const items = group.items.filter((item) => canManage || !item.manageOnly);
                    if (items.length === 0) return null;
                    return (
                      <SidebarPrimitive.Group key={group.label} className="mt-3">
                        <SidebarPrimitive.GroupLabel>{group.label}</SidebarPrimitive.GroupLabel>
                        <SidebarPrimitive.Menu aria-label={group.label}>
                          {items.map((item) => (
                            <SidebarPrimitive.MenuItem
                              key={item.id}
                              id={item.id}
                              isCurrent={shown === item.id}
                              onAction={() => setSection(item.id)}
                            >
                              <SidebarPrimitive.MenuIcon>
                                <item.icon size={13} />
                              </SidebarPrimitive.MenuIcon>
                              <SidebarPrimitive.MenuItemContent>
                                <SidebarPrimitive.MenuLabel>{item.label}</SidebarPrimitive.MenuLabel>
                                {counts[item.id] != null ? (
                                  <SidebarPrimitive.MenuChip>{counts[item.id]}</SidebarPrimitive.MenuChip>
                                ) : null}
                              </SidebarPrimitive.MenuItemContent>
                            </SidebarPrimitive.MenuItem>
                          ))}
                        </SidebarPrimitive.Menu>
                      </SidebarPrimitive.Group>
                    );
                  })}
                </nav>
              </SidebarPrimitive.Content>
            </SidebarPrimitive>

            <div className="scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 pr-12 md:px-8 md:py-7 md:pr-12">
              {shown === "general" ? (
                // General needs nothing from the roster read, so it is usable
                // even when that read failed.
                <GeneralSection
                  slug={workspace.slug}
                  name={name}
                  metadata={metadata}
                  role={role}
                  canManage={canManage}
                  onSaved={(next) => {
                    setName(next.name);
                    setMetadata(next.metadata);
                  }}
                />
              ) : error ? (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              ) : !roster ? (
                <SectionSkeleton />
              ) : shown === "members" ? (
                <MembersSection
                  slug={workspace.slug}
                  workspaceName={name}
                  roster={roster}
                  onChanged={load}
                  onGo={setSection}
                />
              ) : shown === "invitations" ? (
                <InvitationsSection
                  slug={workspace.slug}
                  workspaceName={name}
                  invites={roster.invites}
                  onChanged={load}
                />
              ) : (
                <UsageSection usage={usage} unavailable={usageError} />
              )}
            </div>
          </SidebarPrimitive.Provider>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * What a section looks like before it has anything to say: a heading, its
 * sentence and a few blocks, shaped like the sections themselves so it reads
 * as "loading" rather than as the wrong screen having opened.
 */
function SectionSkeleton() {
  return (
    <div role="status" aria-label="Loading the workspace">
      <Skeleton className="h-5 w-40 rounded" />
      <Skeleton className="mt-2 h-3 w-full max-w-md rounded" />
      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[74px] rounded-[10px]" />
        ))}
      </div>
      <Skeleton className="mt-8 h-4 w-32 rounded" />
      <Skeleton className="mt-3 h-[92px] w-full rounded-[10px]" />
      <Skeleton className="mt-3 h-[92px] w-full rounded-[10px]" />
    </div>
  );
}
