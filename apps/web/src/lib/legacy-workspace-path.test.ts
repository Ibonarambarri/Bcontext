import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CHILD_SEGMENTS,
  currentWorkspacePath,
  legacyWorkspacePath,
} from "./legacy-workspace-path";

describe("legacyWorkspacePath", () => {
  it("leaves current workspace URLs alone", () => {
    expect(legacyWorkspacePath("/w/docs")).toBeNull();
    expect(legacyWorkspacePath("/w/docs/")).toBeNull();
    expect(legacyWorkspacePath("/w/docs/n/abc")).toBeNull();
    expect(legacyWorkspacePath("/w/docs/v/graph")).toBeNull();
    expect(legacyWorkspacePath("/w/docs/s/some-node")).toBeNull();
    for (const segment of WORKSPACE_CHILD_SEGMENTS) {
      expect(legacyWorkspacePath(`/w/docs/${segment}`), segment).toBeNull();
    }
  });

  it("reads a two-segment address as a legacy pair", () => {
    expect(legacyWorkspacePath("/w/acme/docs")).toEqual({
      ref: "acme~docs",
      fallbackSlug: "docs",
      rest: "",
    });
    expect(legacyWorkspacePath("/w/acme/docs/")).toEqual({
      ref: "acme~docs",
      fallbackSlug: "docs",
      rest: "",
    });
  });

  it("keeps everything below the pair", () => {
    expect(legacyWorkspacePath("/w/acme/docs/n/abc-123")?.rest).toBe("/n/abc-123");
    expect(legacyWorkspacePath("/w/acme/docs/v/graph")?.rest).toBe("/v/graph");
    expect(legacyWorkspacePath("/w/acme/docs/views/42")?.rest).toBe("/views/42");
  });

  it("lowercases the pair, as the API reads it", () => {
    expect(legacyWorkspacePath("/w/Acme/Docs/n/x")).toEqual({
      ref: "acme~docs",
      fallbackSlug: "docs",
      rest: "/n/x",
    });
  });

  it("ignores what was never a workspace address", () => {
    expect(legacyWorkspacePath("/workspaces")).toBeNull();
    expect(legacyWorkspacePath("/w")).toBeNull();
    expect(legacyWorkspacePath("/w/")).toBeNull();
    expect(legacyWorkspacePath("/w/acme/not%20a%20slug")).toBeNull();
    expect(legacyWorkspacePath("/w/-bad/docs")).toBeNull();
  });

  it("builds the current path from the slug and the rest", () => {
    expect(currentWorkspacePath("docs-2", "/n/abc")).toBe("/w/docs-2/n/abc");
    expect(currentWorkspacePath("docs", "")).toBe("/w/docs");
  });
});

describe("WORKSPACE_CHILD_SEGMENTS", () => {
  it("is exactly the static children of the app/w/[ws] route tree", () => {
    // A child added under app/w/[ws] and missing here would be taken for a
    // legacy pair and redirected away from; this keeps the two in step.
    const tree = join(process.cwd(), "src/app/w/[ws]");
    const children = readdirSync(tree, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Dynamic segments, route groups and private folders never appear as
      // a literal second path segment.
      .filter((name) => !/^[[(_@]/.test(name))
      .sort();
    expect([...WORKSPACE_CHILD_SEGMENTS].sort()).toEqual(children);
  });
});
