"use client";

/**
 * The workspace switcher at the top of the sidebar: the current workspace
 * as a gradient tile + name + slug, and a dropdown of every workspace the
 * person belongs to, with one link out to `/workspaces`. Data comes from the
 * workspace context — the hub's card list is passed down by the layout, so
 * switching needs no fetch.
 *
 * `sortedWorkspaces` is pure and unit-tested (`workspace-switcher.test.ts`).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { ChevronsUpDown, LayoutGrid } from "lucide-react";
import { Dropdown, Separator } from "@heroui/react";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";
import { gradientCss, gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { workspacePath } from "@/web/workspace-url";
import { useWorkspace } from "./workspace-context";

export const ALL_WORKSPACES_PATH = "/workspaces" as Route;

/**
 * Every workspace the person belongs to, by name. One flat list: a
 * workspace is the top-level thing, so there is nothing to group by, and the
 * name is what people scan for. Ties fall back to the slug so the order is
 * stable between renders.
 */
export function sortedWorkspaces(workspaces: WorkspaceCard[]): WorkspaceCard[] {
  return [...workspaces].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );
}

export function WorkspaceSwitcher() {
  const { address, workspace, workspaces, workspaceSlug } = useWorkspace();
  const router = useRouter();

  const initial = (workspace?.name ?? workspaceSlug).slice(0, 1).toUpperCase();
  const activeGradient = gradientFor({
    slug: workspaceSlug,
    metadata: workspace?.metadata ?? null,
  });
  const rows = sortedWorkspaces(workspaces);

  // Keys are slugs: unique across the instance, and the address itself.
  const navigateToWorkspace = (slug: string) => {
    router.push(workspacePath(slug) as Route);
  };

  const renderRow = (item: WorkspaceCard) => {
    const gradient = gradientFor({ slug: item.slug, metadata: item.metadata ?? null });
    return (
      <Dropdown.Item
        key={item.id}
        id={item.slug}
        textValue={item.name}
        className="rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] data-[hovered=true]:bg-[var(--paper-2)] data-[hovered=true]:text-[var(--ink)] data-[selected=true]:bg-[var(--paper-3)] data-[selected=true]:text-[var(--ink)]"
      >
        {({ isSelected }: { isSelected: boolean }) => (
          <div className="flex w-full items-center gap-2">
            <WorkspaceAvatar
              initial={item.name.slice(0, 1).toUpperCase()}
              gradient={gradient}
              size={20}
              textSize={12}
            />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {isSelected ? <Dropdown.ItemIndicator className="text-[var(--ink-3)]" /> : null}
          </div>
        )}
      </Dropdown.Item>
    );
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Dropdown>
        <Dropdown.Trigger
          aria-label="Switch workspace"
          className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--paper-2)] outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
        >
          <span
            title="Switch workspace"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <WorkspaceAvatar
              initial={initial}
              gradient={activeGradient}
              size={32}
              textSize={18}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                {workspace?.name ?? workspaceSlug}
              </span>
              <span className="truncate text-[11px] leading-tight text-muted">
                {address.slug}
              </span>
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted" />
          </span>
        </Dropdown.Trigger>

        <Dropdown.Popover
          placement="bottom start"
          className="w-[var(--trigger-width)] min-w-[248px] rounded-xl p-1.5 fade-in outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
        >
          <Dropdown.Menu
            aria-label="Workspace selector"
            selectionMode="single"
            selectedKeys={new Set([address.slug])}
            onAction={(key) => navigateToWorkspace(String(key))}
          >
            <Dropdown.Section>{rows.map((item) => renderRow(item))}</Dropdown.Section>
          </Dropdown.Menu>

          <Separator className="my-1 border-t border-[var(--line)]" />

          {/* The way back to the hub. Settings for the workspace are not
              here: this menu answers "which workspace", and a settings row
              inside it made choosing a workspace and configuring one look
              like the same kind of act. Cmd+, still opens them. */}
          <Link
            href={ALL_WORKSPACES_PATH}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            All workspaces
            <LayoutGrid size={14} className="ml-auto text-muted" />
          </Link>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}

/**
 * Gradient identity tile. Avatar proportions: the glyph runs at ~55–60% of
 * the tile edge (semibold, line-height 1 so it centres optically) — at a
 * polite ~44% the letter is illegible at sidebar sizes.
 */
function WorkspaceAvatar({
  initial,
  gradient,
  size,
  textSize,
}: {
  initial: string;
  gradient: { from: string; to: string };
  size: number;
  textSize: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: textSize,
        lineHeight: 1,
        background: gradientCss(gradient as never),
        textShadow: "0 1px 1px rgba(0,0,0,0.18)",
      }}
    >
      {initial}
    </div>
  );
}
