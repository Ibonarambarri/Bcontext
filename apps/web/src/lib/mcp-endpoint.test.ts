import { describe, expect, it } from "vitest";
import { mcpServerName, parseMcpResource, workspaceMcpEndpoint } from "./mcp-endpoint";

const ORIGIN = "https://your-bcontext.example";

describe("workspace MCP endpoint", () => {
  it("builds <origin>/mcp/<slug>", () => {
    expect(workspaceMcpEndpoint(ORIGIN, { slug: "docs" })).toBe(
      "https://your-bcontext.example/mcp/docs",
    );
    expect(workspaceMcpEndpoint(`${ORIGIN}/`, { slug: "docs" })).toBe(
      "https://your-bcontext.example/mcp/docs",
    );
  });

  it("names the client config entry per workspace", () => {
    expect(mcpServerName({ slug: "docs" })).toBe("bcontext-docs");
  });

  it("round-trips through the resource parser", () => {
    expect(parseMcpResource(workspaceMcpEndpoint(ORIGIN, { slug: "docs" }), ORIGIN)).toEqual({
      kind: "workspace",
      slug: "docs",
    });
  });
});

describe("parseMcpResource", () => {
  it("reads a workspace endpoint", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp/docs`, ORIGIN)).toEqual({
      kind: "workspace",
      slug: "docs",
    });
  });

  it("recognises the legacy two-segment endpoint without treating it as a slug", () => {
    // Written into .mcp.json files before 0100; the API still serves it and
    // the consent screen resolves it to today's workspace.
    expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs`, ORIGIN)).toEqual({
      kind: "legacy",
      ref: "acme~docs",
    });
  });

  it("recognises the root endpoint", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp`, ORIGIN)).toEqual({ kind: "root" });
    expect(parseMcpResource(`${ORIGIN}/mcp/`, ORIGIN)).toEqual({ kind: "root" });
  });

  it("ignores a trailing slash, a query and a fragment", () => {
    for (const noise of ["/", "?x=1", "#frag", "/?x=1#frag"]) {
      expect(parseMcpResource(`${ORIGIN}/mcp/docs${noise}`, ORIGIN)).toEqual({
        kind: "workspace",
        slug: "docs",
      });
    }
  });

  it("tolerates a trailing slash on the app origin", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp/docs`, `${ORIGIN}/`)).toEqual({
      kind: "workspace",
      slug: "docs",
    });
  });

  it("rejects a foreign origin", () => {
    expect(parseMcpResource("https://evil.example/mcp/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource("http://your-bcontext.example/mcp/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource("https://your-bcontext.example:8443/mcp", ORIGIN)).toBeNull();
  });

  it("rejects garbage and paths that are not an endpoint", () => {
    expect(parseMcpResource(undefined, ORIGIN)).toBeNull();
    expect(parseMcpResource(null, ORIGIN)).toBeNull();
    expect(parseMcpResource("", ORIGIN)).toBeNull();
    expect(parseMcpResource("not a url", ORIGIN)).toBeNull();
    expect(parseMcpResource("/mcp/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/api/mcp`, ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs/extra`, ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/mcp/a%20b`, ORIGIN)).toBeNull();
  });

  it("is null when the app origin itself is not a URL", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp`, "")).toBeNull();
  });
});
