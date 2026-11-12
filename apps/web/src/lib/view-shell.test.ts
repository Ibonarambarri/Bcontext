import { describe, expect, it } from "vitest";
import { legacyAdminDestination, SYSTEM_VIEW_KEYS, systemViewPath, viewSlugFromPathname } from "./view-shell";

const ws = { slug: "acme" };

describe("legacy admin destinations", () => {
  it("sends the old tool-provider tabs (and the interim webhooks tab) to Tools", () => {
    for (const tab of ["providers", "tools", "webhooks"]) {
      expect(legacyAdminDestination(ws, "connections", new URLSearchParams({ tab }))).toBe("/w/acme/v/tools");
    }
  });

  it("sends everything else to Agents and keeps the rest of the query", () => {
    expect(legacyAdminDestination(ws, "agents", new URLSearchParams({ tab: "agents", focus: "a1" }))).toBe("/w/acme/v/agents?focus=a1");
    expect(legacyAdminDestination(ws, "connections", new URLSearchParams({ surface: "x" }))).toBe("/w/acme/v/agents");
  });

  it("has `tools` as the system view and no `webhooks` one (that slug only redirects)", () => {
    expect(SYSTEM_VIEW_KEYS).toContain("tools");
    expect(SYSTEM_VIEW_KEYS).not.toContain("webhooks");
  });
});

describe("What's new", () => {
  it("is a system view under v/, highlighted by its own slug", () => {
    expect(SYSTEM_VIEW_KEYS).toContain("whats-new");
    expect(systemViewPath(ws, "whats-new")).toBe("/w/acme/v/whats-new");
    expect(viewSlugFromPathname("/w/acme/v/whats-new", ws)).toBe("whats-new");
  });
});
