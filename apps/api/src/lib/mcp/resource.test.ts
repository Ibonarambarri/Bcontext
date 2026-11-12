/**
 * How an MCP endpoint is named as an OAuth resource, and how a client's
 * `resource` parameter is read back. The rules that matter: the per-workspace
 * document sits at the RFC 9728 path derived from the endpoint; a `resource`
 * is accepted on either host the server answers on; nothing but `/mcp`,
 * `/mcp/<slug>` and the legacy `/mcp/<org>/<workspace>` alias is one of ours.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  baseUrlFor,
  mcpResourceUrl,
  parseMcpResource,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "./resource";

const req = (url = "https://api.bcontext.test/api/oauth/token") => new Request(url, { method: "POST" });

describe("mcp resource URLs", () => {
  afterEach(() => {
    delete process.env.APP_URL;
  });

  it("names the root and the per-workspace endpoints", () => {
    expect(mcpResourceUrl("https://x.test")).toBe("https://x.test/mcp");
    expect(mcpResourceUrl("https://x.test", "docs")).toBe("https://x.test/mcp/docs");
    expect(mcpResourceUrl("https://x.test", "acme/docs")).toBe("https://x.test/mcp/acme/docs");
  });

  it("puts the per-workspace metadata at the RFC 9728 §3.1 path", () => {
    expect(protectedResourceMetadataUrl("https://x.test")).toBe("https://x.test/.well-known/oauth-protected-resource");
    expect(protectedResourceMetadataUrl("https://x.test", "docs")).toBe(
      "https://x.test/.well-known/oauth-protected-resource/mcp/docs",
    );
    expect(protectedResourceMetadataUrl("https://x.test", "acme/docs")).toBe(
      "https://x.test/.well-known/oauth-protected-resource/mcp/acme/docs",
    );
  });

  it("publishes the same document per endpoint, differing only in resource", () => {
    const root = protectedResourceMetadata("https://x.test");
    const ws = protectedResourceMetadata("https://x.test", "docs");
    expect(root.resource).toBe("https://x.test/mcp");
    expect(ws.resource).toBe("https://x.test/mcp/docs");
    expect({ ...ws, resource: root.resource }).toEqual(root);
  });

  it("prefers the configured app URL as the base, the request origin otherwise", () => {
    expect(baseUrlFor(req())).toBe("https://api.bcontext.test");
    process.env.APP_URL = "https://app.bcontext.test/";
    expect(baseUrlFor(req())).toBe("https://app.bcontext.test");
  });
});

describe("parseMcpResource", () => {
  afterEach(() => {
    delete process.env.APP_URL;
  });

  it("binds nothing when the client sent no resource", () => {
    expect(parseMcpResource(req(), undefined)).toBeUndefined();
    expect(parseMcpResource(req(), "  ")).toBeUndefined();
  });

  it("reads the root endpoint and a workspace endpoint, tolerating slash, query and fragment", () => {
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp")).toEqual({ kind: "root" });
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/")).toEqual({ kind: "root" });
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/docs/?x=1#y")).toEqual({
      kind: "workspace",
      ref: { kind: "slug", slug: "docs" },
      name: "docs",
    });
    // The pre-0100 alias is still one of ours, read as the legacy pair.
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/acme/docs")).toEqual({
      kind: "workspace",
      ref: { kind: "legacy", legacy: { org: "acme", workspace: "docs" }, name: "acme/docs" },
      name: "acme/docs",
    });
  });

  it("accepts the configured app host as well as the host the request came in on", () => {
    process.env.APP_URL = "https://app.bcontext.test";
    expect(parseMcpResource(req(), "https://app.bcontext.test/mcp/docs")?.kind).toBe("workspace");
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/docs")?.kind).toBe("workspace");
  });

  it("refuses another host, another path or a malformed name", () => {
    expect(parseMcpResource(req(), "https://evil.test/mcp")).toBeNull();
    expect(parseMcpResource(req(), "https://api.bcontext.test/api/nodes")).toBeNull();
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/Acme Inc")).toBeNull();
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/acme/docs/extra")).toBeNull();
    expect(parseMcpResource(req(), "https://api.bcontext.test/mcp/Acme Inc/docs")).toBeNull();
    expect(parseMcpResource(req(), "not a url")).toBeNull();
  });
});
