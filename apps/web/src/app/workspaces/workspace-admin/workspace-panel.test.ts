import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scopeSummary } from "./panel-ui";
import { PANEL_SECTIONS, parsePanelSection } from "./sections";

/**
 * The workspace panel, as a set of rules rather than a rendering.
 *
 * These are the decisions that are easy to undo by accident six months from
 * now — a section reintroducing the slug because it was handy, a per-person
 * "which workspaces" picker coming back, a drawer instead of a dialog. Each
 * one cost a conversation; a grep is cheap insurance that the conversation is
 * not had twice.
 */

const here = join(process.cwd(), "src/app/workspaces/workspace-admin");
const read = (path: string) => readFileSync(join(here, path), "utf8");

const SECTIONS = [
  "general-section.tsx",
  "members-section.tsx",
  "member-detail.tsx",
  "invitations-section.tsx",
  "usage-section.tsx",
  "business-section.tsx",
  "record-types-section.tsx",
  "ingest-keys-section.tsx",
];

describe("the workspace panel", () => {
  it("is a centred dialog, blurred behind", () => {
    const modal = read("workspace-admin-modal.tsx");
    expect(modal).toContain("Modal.Backdrop");
    expect(modal).toContain("backdrop-blur-");
    expect(modal).toContain('placement="center"');
    expect(modal).not.toContain("Sheet");
  });

  it("groups its sections into the workspace, the people in it and its business", () => {
    const modal = read("workspace-admin-modal.tsx");
    for (const group of ["Workspace", "People", "Business"]) {
      expect(modal).toContain(`label: "${group}"`);
    }
    for (const section of PANEL_SECTIONS) {
      expect(modal).toContain(`id: "${section}"`);
    }
  });

  it("keeps the sections a non-manager cannot use out of their rail", () => {
    const modal = read("workspace-admin-modal.tsx");
    expect(modal).toMatch(/id: "invitations"[^}]*manageOnly: true/);
    expect(modal).toMatch(/id: "usage"[^}]*manageOnly: true/);
    expect(modal).toMatch(/id: "ingest-keys"[^}]*manageOnly: true/);
    expect(modal).toContain("can_manage");
  });

  it("navigates with the product's own Sidebar, not a list of buttons", () => {
    const modal = read("workspace-admin-modal.tsx");
    expect(modal).toContain("Sidebar as SidebarPrimitive");
    expect(modal).toContain("SidebarPrimitive.GroupLabel");
    expect(modal).toContain("SidebarPrimitive.MenuItem");
    // It is built for a page. The dialog undoes those page-sized rules in
    // one scoped place rather than reimplementing the component.
    expect(modal).toContain("workspace-panel");
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".workspace-panel .sidebar");
    expect(css).not.toMatch(/\.workspace-panel[^{]*\{[^}]*!important/);
    expect(css).toMatch(/\.workspace-panel\.modal__dialog\s*\{[^}]*padding:\s*0/);
  });

  it("never prints the workspace's address", () => {
    for (const file of [...SECTIONS, "workspace-admin-modal.tsx"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/`\/w\/\$\{/);
      expect(source, file).not.toContain("workspaceName(");
      expect(source, file).not.toMatch(/>\s*\/w\//);
    }
  });

  it("has no per-person workspace picker: membership is the access", () => {
    for (const file of ["members-section.tsx", "member-detail.tsx", "invitations-section.tsx"]) {
      const source = read(file);
      expect(source, file).not.toContain("CheckboxButtonGroup");
      expect(source, file).not.toContain("workspaces:");
    }
  });

  it("gathers one person's role, agents and removal on one screen", () => {
    const detail = read("member-detail.tsx");
    expect(detail).toContain("detail.agents");
    expect(detail).toContain("is_last_owner");
    expect(detail).toContain('method: "PATCH"');
    expect(detail).toContain('method: "DELETE"');
  });

  it("offers a record type's storage only while creating it, and says why", () => {
    const source = read("record-types-section.tsx");
    expect(source).toContain("disabled={!draft.isNew || pending}");
    expect(source).toContain("cannot be changed after the type is created");
    // An existing field's key is where its values are stored.
    expect(source).toContain("isDisabled={disabled || !field.isNew}");
  });

  it("shows an ingest key's secret once, from state, with a copy button", () => {
    const source = read("ingest-keys-section.tsx");
    expect(source).toContain("will not be shown again");
    expect(source).toContain("navigator.clipboard");
    expect(source).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it("speaks only to the workspace routes of the API", () => {
    for (const file of [...SECTIONS, "workspace-admin-modal.tsx"]) {
      expect(read(file), file).not.toMatch(/\/api\/(?!workspaces\/)/);
    }
  });
});

describe("parsePanelSection", () => {
  it("accepts every section and nothing else", () => {
    for (const section of PANEL_SECTIONS) expect(parsePanelSection(section)).toBe(section);
    expect(parsePanelSection("overview")).toBeNull();
    expect(parsePanelSection("")).toBeNull();
    expect(parsePanelSection(undefined)).toBeNull();
  });
});

describe("scopeSummary", () => {
  it("says full access instead of listing what admin already holds", () => {
    expect(scopeSummary(["nodes:read", "admin:*"])).toBe("full access");
  });

  it("lists a few scopes and counts the rest", () => {
    expect(scopeSummary([])).toBe("no scopes");
    expect(scopeSummary(["nodes:read", "nodes:write"])).toBe("nodes:read nodes:write");
    expect(scopeSummary(["a", "b", "c", "d", "e"])).toBe("a b +3 more");
  });
});
