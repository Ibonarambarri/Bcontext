/**
 * The web is for reading and reviewing; agents write. These checks keep the
 * navigation honest about that without rendering it (the suite runs in
 * node): manual creation is not a primary action, but it is still reachable,
 * and "What's new" sits at the top of the sidebar with its route wired.
 *
 * Scanned from source, like `web-speaks-http.test.ts`, because what matters
 * is which component offers what, not how it renders.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("read-first navigation", () => {
  it("has no create-node entry in the sidebar", () => {
    const sidebar = read("components/sidebar.tsx");
    expect(sidebar).not.toMatch(/dispatchEvent\(new CustomEvent\("bcontext:new-node"\)\)/);
    expect(sidebar).not.toMatch(/id="new-node"/);
  });

  it("puts What's new right after Dashboard, before the Knowledge group", () => {
    const sidebar = read("components/sidebar.tsx");
    const dashboard = sidebar.indexOf('id="overview"');
    const whatsNew = sidebar.indexOf('id="whats-new"');
    const knowledge = sidebar.indexOf("<SidebarPrimitive.GroupLabel>Knowledge");
    expect(dashboard).toBeGreaterThan(-1);
    expect(whatsNew).toBeGreaterThan(dashboard);
    expect(knowledge).toBeGreaterThan(whatsNew);
    expect(sidebar).toMatch(/useWhatsNewCount\(\)/);
  });

  it("routes v/whats-new to the review surface", () => {
    expect(read("app/w/[ws]/v/[view]/page.tsx")).toMatch(/decoded === "whats-new"\) return <WhatsNewView \/>/);
  });

  it("keeps manual creation reachable from the palette and ⌘⇧K", () => {
    expect(read("components/command-palette.tsx")).toMatch(/new CustomEvent\("bcontext:new-node"\)/);
    expect(read("components/create-node-dialog-host.tsx")).toMatch(/e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "k"/);
  });

  it("sends an empty workspace to the agent instead of seeding nodes by hand", () => {
    const empty = read("components/workspace-empty-state.tsx");
    expect(empty).not.toMatch(/createNode\(/);
    expect(empty).toMatch(/FIRST_WRITE_PROMPT/);
    expect(empty).toMatch(/systemViewPath\(address, "agents"\)/);
  });

  it("mounts the ask box in the workspace header", () => {
    expect(read("components/workspace-shell.tsx")).toMatch(/<AskBrain \/>/);
  });
});
