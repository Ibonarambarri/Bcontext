import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";
import { ALL_WORKSPACES_PATH, sortedWorkspaces } from "./workspace-switcher";

function workspace(slug: string, name = slug): WorkspaceCard {
  return {
    id: `id-${slug}`,
    slug,
    name,
    description: null,
    github_repo: null,
    metadata: {},
    created_at: "2026-07-18T00:00:00.000Z",
    role: "owner",
    member_count: 1,
    open_task_count: 0,
    node_count: 0,
    last_activity_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("sidebar workspace selector", () => {
  it("exposes the canonical route back to the workspace hub", () => {
    expect(ALL_WORKSPACES_PATH).toBe("/workspaces");
  });

  it("renders a headerless shell with the selector owned by the sidebar", () => {
    const shellSource = readFileSync(new URL("./workspace-shell.tsx", import.meta.url), "utf8");
    const sidebarSource = readFileSync(new URL("./sidebar.tsx", import.meta.url), "utf8");

    expect(shellSource).not.toContain("TopBar");
    expect(sidebarSource.indexOf("<WorkspaceSwitcher />")).toBeLessThan(
      sidebarSource.indexOf('<nav aria-label="Primary workspace navigation"'),
    );
    // Collapsed sidebar hides entirely (offcanvas) — the shell's native
    // Trigger reopens it, so no compact selector variant exists anymore.
    expect(shellSource).toContain("SidebarShell.Trigger");
    expect(sidebarSource).toContain("SidebarPrimitive.Mobile");
  });
});

describe("every workspace, one flat list", () => {
  it("lists every workspace the person belongs to, by name", () => {
    const list = sortedWorkspaces([
      workspace("product", "Product"),
      workspace("docs", "Docs"),
      workspace("archive", "Archive"),
    ]);

    expect(list.map((w) => w.slug)).toEqual(["archive", "docs", "product"]);
  });

  it("breaks a tie on the name by slug, so the order is stable", () => {
    const list = sortedWorkspaces([workspace("docs-2", "Docs"), workspace("docs", "Docs")]);

    expect(list.map((w) => w.slug)).toEqual(["docs", "docs-2"]);
  });

  it("does not reorder the list it was given", () => {
    const input = [workspace("b"), workspace("a")];
    sortedWorkspaces(input);
    expect(input.map((w) => w.slug)).toEqual(["b", "a"]);
  });
});
