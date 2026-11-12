"use client";

/**
 * Workspaces hub — the launcher listing every workspace the user belongs to,
 * rendered by `app/workspaces/page.tsx` from the view models it builds.
 *
 * Matches the Agents surface family: clean header row, a Filter toggle that
 * reveals an Activity-style filters bar (grid-template-rows height
 * animation), a responsive card grid, and dialogs for creating a workspace
 * and for a workspace's own panel (`workspace-admin/`). All chrome comes from
 * HeroUI, src/components/ui and theme tokens.
 *
 * A workspace is the top-level thing, so the hub is one flat grid. The two
 * acts people come here for each live in exactly one place: "New workspace"
 * in the header (only when `canCreate` — the instance's creation policy), and
 * a workspace's panel behind the gear on its card, URL-driven through
 * `?ws=<slug>` so it survives a reload and can be linked to.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import type { ComponentType } from "react";
import {
  ArrowDownUp,
  GitBranch,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
import {
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemCard } from "@/components/ui/item-card";
import { NewWorkspaceModal, type TemplateSummary } from "./new-workspace-modal";
import { WorkspaceAdminModal } from "./workspace-admin/workspace-admin-modal";
import type { PanelSection } from "./workspace-admin/sections";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@bcontext-dev/contract/utils";
import { gradientCss, gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { workspacePath } from "@/web/workspace-url";

type Role = "owner" | "admin" | "editor" | "viewer" | "agent";

/** A workspace card, as `page.tsx` builds it from the API's `WorkspaceCard`. */
export interface WorkspaceVM {
  id: string;
  slug: string;
  name: string;
  glyph: string;
  description: string | null;
  /** The caller's role in this workspace. */
  role: Role;
  memberCount: number;
  taskCount: number;
  nodeCount: number;
  accent: number;
  /** True if the accent was explicitly chosen (otherwise it's deterministic). */
  accentCustom: boolean;
  /** Workspace metadata blob — reads `accent_gradient` for the gradient theme. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
  lastActivity: string;
  githubRepo: string | null;
}

interface Props {
  workspaces: WorkspaceVM[];
  /** May this person create a workspace? `WorkspacesResponse.can_create_workspace`. */
  canCreate: boolean;
  /** Workspace whose panel should be open (driven by `?ws=` in the URL). */
  panelWs: WorkspaceVM | null;
  /** The part of the panel it opens on (`&section=`), when one was named. */
  panelSection: PanelSection | null;
  /** What a new workspace may start with; the create dialog offers them. */
  templates: TemplateSummary[];
}

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

const display: React.CSSProperties = {
  fontFamily: "var(--f-bricolage), var(--font-sans), sans-serif",
  fontWeight: 700,
  letterSpacing: "-0.028em",
};

function relAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(1, (Date.now() - t) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d ago`;
  // Fixed locale: toLocaleDateString() hydration-mismatches when the server
  // (en-US) and the browser (e.g. es) disagree on date order.
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/* ── Filters ─────────────────────────────────────────────────────────── */

type SortKey = "activity" | "name" | "created";

interface HubFilters {
  q: string;
  role: "" | Role;
  sort: SortKey;
}

const EMPTY_FILTERS: HubFilters = { q: "", role: "", sort: "activity" };

function countActiveFilters(filters: HubFilters): number {
  let count = 0;
  if (filters.q.trim() !== "") count += 1;
  if (filters.role !== "") count += 1;
  if (filters.sort !== "activity") count += 1;
  return count;
}

export function WorkspacesView({
  workspaces,
  canCreate,
  panelWs,
  panelSection,
  templates,
}: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState<HubFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = countActiveFilters(filters);

  // The panel is URL-driven: ?ws=<slug> opens it for that workspace. Closing
  // clears the param so the grid is the canonical hub state, and refreshes
  // it: a rename, a new member or a revoked invitation all change a card.
  const closePanel = () => {
    router.push("/workspaces" as Route);
    router.refresh();
  };
  const openPanel = (ws: WorkspaceVM) =>
    router.push(`/workspaces?ws=${encodeURIComponent(ws.slug)}` as Route);

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const filtered = workspaces.filter((w) => {
      if (
        q &&
        !w.name.toLowerCase().includes(q) &&
        !w.slug.toLowerCase().includes(q) &&
        !(w.description ?? "").toLowerCase().includes(q)
      ) {
        return false;
      }
      if (filters.role && w.role !== filters.role) return false;
      return true;
    });
    return filtered.toSorted((a, b) => {
      if (filters.sort === "name") return a.name.localeCompare(b.name);
      if (filters.sort === "created") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });
  }, [workspaces, filters]);

  const nothingMatches = workspaces.length > 0 && visible.length === 0;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--paper)] text-[13px] text-[var(--ink)]" style={{ fontFamily: "var(--f-figtree), var(--font-sans), ui-sans-serif, sans-serif" }}>
      <TopNav />

      <main className="scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-7 pb-16 pt-7 max-sm:px-4 max-sm:pb-[calc(56px+env(safe-area-inset-bottom))] max-sm:pt-5">
          {workspaces.length === 0 && !canCreate ? (
            <HubEmptyState />
          ) : (
            <>
              {/* Header row — Agents family: title block · Filter toggle · CTA. */}
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <h1 className="m-0 text-[24px] leading-tight text-[var(--ink)]" style={display}>
                    Workspaces
                  </h1>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
                    {workspaces.length}{" "}
                    {workspaces.length === 1 ? "workspace" : "workspaces"} · sorted by{" "}
                    {filters.sort === "name"
                      ? "name"
                      : filters.sort === "created"
                        ? "creation date"
                        : "last activity"}
                  </p>
                </div>
                <span className="ml-auto" />
                <Button
                  size="sm"
                  variant={filtersOpen ? "secondary" : "outline"}
                  aria-expanded={filtersOpen}
                  aria-controls="workspace-filters-panel"
                  onPress={() => setFiltersOpen((open) => !open)}
                  className={cn("gap-1.5", filtersOpen && "border-[var(--line-strong)]")}
                >
                  <SlidersHorizontal
                    size={13}
                    className={cn(
                      "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                      filtersOpen && "rotate-90",
                    )}
                  />
                  Filter
                  {activeFilterCount > 0 ? (
                    <Chip size="sm" variant="soft" color="accent" className="h-4 min-w-4 px-1 text-[10px]">
                      {activeFilterCount}
                    </Chip>
                  ) : null}
                </Button>
                {canCreate ? (
                  <Button size="sm" className="gap-1.5" onPress={() => setCreating(true)}>
                    <Plus size={14} /> New workspace
                  </Button>
                ) : null}
              </div>

              {/* Collapsible filters — grid-rows height animation, no jumps. */}
              <div
                id="workspace-filters-panel"
                inert={!filtersOpen}
                className={cn(
                  "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  filtersOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={cn(
                      "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                      filtersOpen ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
                    )}
                  >
                    <HubFiltersBar filters={filters} setFilters={setFilters} />
                    <div className="h-1" />
                  </div>
                </div>
              </div>

              {nothingMatches ? (
                <p className="mt-8 py-6 text-center text-[12px] text-[var(--ink-3)]">
                  No workspaces match these filters.
                </p>
              ) : (
                <div className="mt-5">
                  {workspaces.length === 0 ? (
                    <EmptyWorkspaces canCreate={canCreate} onCreate={() => setCreating(true)} />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {visible.map((ws) => (
                        <WorkspaceCard key={ws.id} ws={ws} onSettings={() => openPanel(ws)} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {creating ? (
        <NewWorkspaceModal templates={templates} onClose={() => setCreating(false)} />
      ) : null}
      {panelWs ? (
        <WorkspaceAdminModal
          workspace={{
            slug: panelWs.slug,
            name: panelWs.name,
            metadata: panelWs.metadata,
            role: panelWs.role,
          }}
          initialSection={panelSection ?? undefined}
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Top nav — slim wordmark bar; nav migration tracked apart.   */
/* ──────────────────────────────────────────────────────────── */
function TopNav() {
  return (
    <div className="flex h-[56px] shrink-0 items-center gap-3.5 border-b border-[var(--line)] bg-[var(--paper)] px-5 max-sm:px-3.5">
      <Link
        // `/` server-redirects straight back to this page. The wordmark on
        // the hub points at the hub.
        href={"/workspaces" as Route}
        className="inline-flex items-center text-[16px] font-semibold tracking-[-.015em] text-[var(--ink)] no-underline"
      >
        Bcontext
      </Link>
      <span className="flex-1" />
      {/* The same account row as the workspace sidebar's footer, down to the
          avatar and the two lines: one account menu, two places. */}
      <div className="w-[200px] max-sm:w-auto">
        <UserMenu align="down" profileCard />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Filters bar — same anatomy as the Agents/Activity bars.     */
/* ──────────────────────────────────────────────────────────── */
function HubFiltersBar({
  filters,
  setFilters,
}: {
  filters: HubFilters;
  setFilters: React.Dispatch<React.SetStateAction<HubFilters>>;
}) {
  const set = <K extends keyof HubFilters>(key: K, value: HubFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = countActiveFilters(filters);
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Workspace filters"
      className="mt-4 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          Filter workspaces
        </h3>
        <Chip
          size="sm"
          variant={hasActiveFilters ? "soft" : "secondary"}
          color={hasActiveFilters ? "accent" : "default"}
        >
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div className="grid grid-cols-1 items-end gap-3.5 sm:grid-cols-2 md:grid-cols-[2fr_1fr_1fr_auto]">
        <FilterField label="Search" Icon={Search}>
          <TextField
            aria-label="Search workspaces"
            value={filters.q}
            onChange={(value) => set("q", value)}
            fullWidth
          >
            <Input placeholder="Name, slug or description" />
          </TextField>
        </FilterField>
        <FilterField label="Your role" Icon={UserRound}>
          <FilterSelect
            aria-label="Your role"
            value={filters.role}
            onChange={(value) => set("role", value as HubFilters["role"])}
            items={[
              { id: "", label: "All roles" },
              { id: "owner", label: "Owner" },
              { id: "admin", label: "Admin" },
              { id: "editor", label: "Editor" },
              { id: "viewer", label: "Viewer" },
            ]}
          />
        </FilterField>
        <FilterField label="Sort by" Icon={ArrowDownUp}>
          <FilterSelect
            aria-label="Sort by"
            value={filters.sort}
            onChange={(value) => set("sort", (value || "activity") as SortKey)}
            items={[
              { id: "activity", label: "Last activity" },
              { id: "name", label: "Name" },
              { id: "created", label: "Newest" },
            ]}
          />
        </FilterField>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!hasActiveFilters}
          onPress={() => setFilters(EMPTY_FILTERS)}
          className="mb-0.5 justify-self-end"
        >
          <X size={14} /> Clear
        </Button>
      </div>
    </section>
  );
}

function FilterField({
  label,
  Icon,
  children,
}: {
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <Icon size={13} className="opacity-80" />
        {label}
      </Label>
      {children}
    </div>
  );
}

function FilterSelect({
  "aria-label": ariaLabel,
  value,
  onChange,
  items,
}: {
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(key) => onChange(key == null ? "" : String(key))}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Workspace card — AgentCard family: identity row, one-line    */
/*  description, mono counts, dashed-free footer with chips and  */
/*  last-activity timestamp. Gradient glyph stays custom (it is  */
/*  product domain, per workspace-gradients.ts). The settings    */
/*  gear is a sibling of the card link — no click-hijacking.     */
/* ──────────────────────────────────────────────────────────── */
function WorkspaceCard({
  ws,
  onSettings,
}: {
  ws: WorkspaceVM;
  onSettings: () => void;
}) {
  const grad = gradientFor({ slug: ws.slug, metadata: ws.metadata });

  return (
    <div className="group relative">
      <ItemCard<"a">
        variant="outline"
        className="h-full min-h-[168px] flex-col items-stretch gap-3 rounded-[12px] border-[var(--line)] bg-[var(--paper)] p-4 text-left no-underline transition-colors hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)]"
        render={(props) => (
          <Link {...props} href={workspacePath(ws.slug) as Route} />
        )}
      >
        <div className="flex items-start gap-3">
          <ItemCard.Icon
            className="size-10 shrink-0 rounded-[10px] text-[17px] font-bold text-white"
            style={{ background: gradientCss(grad), textShadow: "0 1px 1px rgba(0,0,0,.2)" }}
          >
            {ws.glyph}
          </ItemCard.Icon>
          <ItemCard.Content className="min-w-0 flex-1">
            <ItemCard.Title className="truncate text-[14px] font-medium text-[var(--ink)]">
              {ws.name}
            </ItemCard.Title>
            <ItemCard.Description className="mt-0.5 truncate text-[10.5px] text-[var(--ink-3)]" style={mono}>
              {ws.slug}
            </ItemCard.Description>
          </ItemCard.Content>
          <Chip size="sm" variant="soft" className="mr-8 shrink-0 capitalize">
            {ws.role}
          </Chip>
        </div>

        <p className="m-0 line-clamp-1 text-[12px] leading-[1.5] text-[var(--ink-2)]">
          {ws.description || "No description yet."}
        </p>

        <div className="flex items-center gap-3.5 text-[10.5px] text-[var(--ink-3)]" style={mono}>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.nodeCount}</b>{" "}
            {ws.nodeCount === 1 ? "node" : "nodes"}
          </span>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.taskCount}</b> open
          </span>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.memberCount}</b>{" "}
            {ws.memberCount === 1 ? "member" : "members"}
          </span>
        </div>

        <div className="mt-auto flex items-center gap-1.5 border-t border-[var(--line)] pt-3">
          {ws.githubRepo ? (
            <Chip size="sm" variant="secondary" className="text-[10px]">
              <GitBranch size={10} />
              <Chip.Label>repo</Chip.Label>
            </Chip>
          ) : null}
          {/* `relAgo` reads the clock while it renders, so the server says
              "59s ago" and the browser, hydrating a moment later, says "1m
              ago". That mismatch is React error #418, which we were actually
              collecting from this page. The value is meant to differ; this
              is the one place the difference is intended rather than a bug. */}
          <span
            suppressHydrationWarning
            className="ml-auto whitespace-nowrap font-mono text-[10px] text-[var(--ink-3)]"
          >
            active {relAgo(ws.lastActivity)}
          </span>
        </div>
      </ItemCard>

      <Button
        isIconOnly
        size="sm"
        variant="tertiary"
        aria-label={`Manage ${ws.name}`}
        onPress={onSettings}
        className="absolute right-2.5 top-2.5 z-[2] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Settings size={14} />
      </Button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Empty states                                                 */
/* ──────────────────────────────────────────────────────────── */

/**
 * Nothing to show at all: the person belongs to no workspace and may not
 * create one. Anybody who may is sent to `/start` before this renders
 * (`page.tsx`), so the people who see it are on an instance where workspaces
 * are created by its administrators — the honest thing is to say who can let
 * them in, not to offer a button that would fail.
 */
function HubEmptyState() {
  return (
    <EmptyState className="mt-10 min-h-[340px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <LayoutGrid size={18} />
        </EmptyState.Media>
        <EmptyState.Title>You&apos;re not in a workspace yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          On this instance, workspaces are created by its administrators. Ask
          one of them, or an owner of the workspace you should be in, for an
          invitation.
        </EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}

/**
 * No workspaces yet, for somebody who may create one — normally only seen in
 * demo mode, since `page.tsx` sends a signed-in person in this state to
 * `/start`. The button opens the same create dialog as the header's.
 */
function EmptyWorkspaces({
  canCreate,
  onCreate,
}: {
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <EmptyState className="mt-3 min-h-[180px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <LayoutGrid size={18} />
        </EmptyState.Media>
        <EmptyState.Title>No workspaces yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          {canCreate
            ? "One workspace per product, team or client, with its own members and agents."
            : "An administrator creates the first workspace."}
        </EmptyState.Description>
      </EmptyState.Header>
      {canCreate ? (
        <EmptyState.Content>
          <Button size="sm" className="gap-1.5" onPress={onCreate}>
            <Plus size={14} /> New workspace
          </Button>
        </EmptyState.Content>
      ) : null}
    </EmptyState>
  );
}
