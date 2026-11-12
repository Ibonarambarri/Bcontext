/**
 * The v0.4.1 follow-ups to the business layer, checked where they live.
 * The pure halves (side names, promote targets, ingest batches, the heatmap
 * legend) have their own unit tests; these pin the wiring a browser pass
 * found missing, scanned from source because the suite runs in node.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { businessModelFrom, parseStoredModel } from "@/app/start/business-model";

const SRC = join(process.cwd(), "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("sign-up asks the business model", () => {
  it("reads the choice, and anything unknown is product", () => {
    expect(businessModelFrom(form({ business_model: "marketplace" }))).toBe("marketplace");
    expect(businessModelFrom(form({ business_model: "b2b" }))).toBe("b2b");
    expect(businessModelFrom(form({}))).toBe("product");
    expect(businessModelFrom(form({ business_model: "enterprise" }))).toBe("product");
    expect(parseStoredModel("b2c")).toBe("b2c");
    expect(parseStoredModel(null)).toBe("product");
  });

  it("offers the four models in both /start forms and sends the choice to the API", () => {
    const formSource = read("app/start/start-form.tsx");
    expect(formSource).toContain('name="business_model"');
    expect(formSource).toContain("BUSINESS_MODEL_OPTIONS");
    expect(formSource.match(/<BusinessModelField /g)).toHaveLength(2);
    const actions = read("app/start/actions.ts");
    expect(actions).toContain("business_model: model");
    expect(actions.match(/businessModelFrom\(formData\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Business settings from Settings", () => {
  it("has a Business row beside Members in the settings rail", () => {
    const dialog = read("components/settings-dialog.tsx");
    expect(dialog).toContain('openWorkspacePanel("business")');
    expect(dialog).toContain('openWorkspacePanel("members")');
  });
});

describe("revoking an ingest key", () => {
  it("asks in the page first, never with window.confirm", () => {
    const section = read("app/workspaces/workspace-admin/ingest-keys-section.tsx");
    expect(section).not.toMatch(/\bconfirm\(/);
    expect(section).toContain("setConfirming(key.id)");
    // The first press only opens the question; only "Revoke key" revokes.
    expect(section).toMatch(/onPress=\{\(\) => setConfirming\(key\.id\)\}>\s*Revoke\s*</);
    expect(section).toMatch(/onPress=\{\(\) => void revoke\(key\)\}>\s*Revoke key/);
  });
});

describe("renamed sides", () => {
  it("names template views by the workspace's words in the sidebar and the header", () => {
    const sidebar = read("components/sidebar.tsx");
    expect(sidebar).toContain("<SidebarPrimitive.MenuLabel>{displayViewName(view, names)}</SidebarPrimitive.MenuLabel>");
    expect(sidebar).toContain("label: displayViewName(custom, names)");
    expect(read("components/workspace-shell.tsx")).toContain("activeViewMeta(activeViewSlug, views, sideNames)");
    expect(read("app/w/[ws]/layout.tsx")).toContain("side_names: names");
  });

  it("renames the overview's marketplace copy and the heatmap's labels", () => {
    expect(read("components/business/business-overview.tsx")).toContain('renameSides("Zones with demand and few suppliers", names)');
    expect(read("components/business/heatmap-renderer.tsx")).toContain("renameSides(spec.second_label ?? spec.second, names)");
  });
});

describe("the supply-vs-demand heatmap", () => {
  it("opens on the latest weeks and names rows after their records", () => {
    const heatmap = read("components/business/heatmap-renderer.tsx");
    expect(heatmap).toContain("element.scrollLeft = element.scrollWidth");
    expect(heatmap).toContain("payload.y_labels?.[row] ?? row");
    expect(heatmap).toContain("heatmapLegend(");
    expect(heatmap).not.toMatch(/darker/);
  });
});

describe("convert to node", () => {
  it("explains, under a dataset table, why no row can be converted", () => {
    const table = read("components/business/record-table.tsx");
    expect(table).toContain("promoteUnavailableNote(source.payload.type, source.payload.promote_targets)");
  });
});
