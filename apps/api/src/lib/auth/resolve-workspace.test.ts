/**
 * Covers how a user-scoped token picks a workspace.
 *
 * Two rules meet here. MCP clients authenticate over OAuth and cannot attach
 * a custom header, so a request with no `X-Bcontext-Workspace` must still
 * resolve when the caller reaches exactly one workspace. And a workspace is
 * named by its slug — or, from configs written before organizations were
 * removed, by an `<org>/<workspace>` pair that resolves through
 * `workspace_legacy_refs`.
 *
 * The per-workspace endpoint (`/mcp/<slug>`, or its legacy alias) hands the
 * name in as `workspaceRef`. For a user token it is the selector; for a
 * workspace token it has to be the token's own workspace, and anything else
 * is a 404 that does not say whether the workspace exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Chainable Supabase admin stub. List queries resolve by awaiting the
// builder itself (PostgrestBuilder is a thenable); single-row lookups go
// through maybeSingle. Same shape as workspace-member.test.ts.
const tableRows: Record<string, unknown[]> = {};
function makeAdmin() {
  const builder = (table: string) => {
    // Lookups by slug, id or legacy pair honour their filter, so a name that
    // does not resolve really resolves to nothing; every other read returns
    // the table as seeded.
    const keyed = new Set(["slug", "id", "legacy_ref"]);
    const where: Array<[string, unknown]> = [];
    const rows = () =>
      ((tableRows[table] ?? []) as Array<Record<string, unknown>>).filter((r) =>
        where.every(([c, v]) => !keyed.has(c) || r[c] === v),
      );
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => {
      where.push([c, v]);
      return b;
    };
    b.is = () => b;
    b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve);
    return b;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => makeAdmin(),
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => {
    throw new Error("not configured in tests");
  },
}));

import { resolveAgentWorkspaceOr401, type Actor } from "./require";

const MCP_URL = "https://app.example.com/mcp";

const agentUser = (agentId: string | null): Actor => ({
  kind: "agent_user",
  userId: "u1",
  scopes: [],
  tokenId: "tok-1",
  ...(agentId ? { agentId } : {}),
});

const workspaceToken: Actor = {
  kind: "agent",
  workspaceId: "ws-1",
  scopes: [],
  tokenId: "tok-ws",
  createdBy: null,
  agentId: null,
};

/** A request shaped like an MCP client's: bearer only, no custom headers. */
function bareRequest(url = MCP_URL): Request {
  return new Request(url, { method: "POST" });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("resolveAgentWorkspaceOr401 — no workspace selector", () => {
  afterEach(() => {
    for (const k of Object.keys(tableRows)) delete tableRows[k];
  });

  it("resolves the single workspace an agent connection can reach", async () => {
    tableRows.agent_workspace_access = [{ workspaces: { id: "ws-1", slug: "bcontext" } }];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toEqual({ workspaceId: "ws-1", slug: "bcontext" });
  });

  it("falls back to memberships for legacy tokens with no agent", async () => {
    tableRows.memberships = [{ workspaces: { id: "ws-9", slug: "solo" } }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(), agentUser(null));
    expect(out).toEqual({ workspaceId: "ws-9", slug: "solo" });
  });

  it("still demands a selector when the caller is ambiguous, naming the candidates", async () => {
    tableRows.agent_workspace_access = [
      { workspaces: { id: "ws-2", slug: "zeta" } },
      { workspaces: { id: "ws-1", slug: "alpha" } },
    ];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error).toBe("workspace_required");
    expect(payload.workspaces).toEqual(["alpha", "zeta"]);
    expect(String(payload.message)).toContain("alpha, zeta");
  });

  it("403s when the connection has no workspace access left", async () => {
    tableRows.agent_workspace_access = [];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("forbidden");
  });

  it("prefers an explicit ?workspace= selector over the fallback", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "other" }];
    tableRows.agent_workspace_access = [{ agent_id: "agent-1" }];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(`${MCP_URL}?workspace=other`),
      agentUser("agent-1"),
    );
    expect(out).toEqual({ workspaceId: "ws-2", slug: "other" });
  });

  it("still reads a legacy <org>/<workspace> selector, through the legacy table", async () => {
    // Renamed by 0100 because another organization used `docs` too: the old
    // pair must land on the renamed workspace, not on whoever has `docs` now.
    tableRows.workspaces = [
      { id: "ws-a", slug: "docs" },
      { id: "ws-b", slug: "globex-docs" },
    ];
    tableRows.workspace_legacy_refs = [{ legacy_ref: "globex/docs", workspace_id: "ws-b" }];
    tableRows.agent_workspace_access = [{ agent_id: "agent-1" }];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(`${MCP_URL}?workspace=globex/docs`),
      agentUser("agent-1"),
    );
    expect(out).toEqual({ workspaceId: "ws-b", slug: "globex-docs" });
  });

  it("404s a selector that names no workspace", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "other" }];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(`${MCP_URL}?workspace=nope`),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(404);
  });
});

describe("resolveAgentWorkspaceOr401 — workspace named by the path", () => {
  afterEach(() => {
    for (const k of Object.keys(tableRows)) delete tableRows[k];
  });

  it("resolves a user token by the path, checking membership as for a header", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs" }];
    tableRows.memberships = [{ user_id: "u1" }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/docs`), agentUser(null), {
      workspaceRef: "docs",
    });
    expect(out).toEqual({ workspaceId: "ws-2", slug: "docs" });
  });

  it("lets the path win over a header that names another workspace", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs" }];
    tableRows.agent_workspace_access = [{ agent_id: "agent-1" }];
    const req = new Request(`${MCP_URL}/docs`, {
      method: "POST",
      headers: { "x-bcontext-workspace": "other" },
    });
    const out = await resolveAgentWorkspaceOr401(req, agentUser("agent-1"), { workspaceRef: "docs" });
    expect(out).toEqual({ workspaceId: "ws-2", slug: "docs" });
  });

  it("403s a user token whose person is not a member of the named workspace", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs" }];
    tableRows.memberships = [];
    const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/docs`), agentUser(null), {
      workspaceRef: "docs",
    });
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
  });

  it("accepts a workspace token on its own workspace's path, new or legacy", async () => {
    tableRows.workspaces = [{ id: "ws-1", slug: "docs" }];
    tableRows.workspace_legacy_refs = [{ legacy_ref: "acme/docs", workspace_id: "ws-1" }];
    for (const ref of ["docs", "acme/docs"]) {
      const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/${ref}`), workspaceToken, {
        workspaceRef: ref,
      });
      expect(out).toEqual({ workspaceId: "ws-1", slug: "docs" });
    }
  });

  it("404s a workspace token on any other path, never a 403", async () => {
    tableRows.workspaces = [
      { id: "ws-1", slug: "docs" },
      { id: "ws-2", slug: "other" },
    ];
    for (const ref of ["other", "nowhere", "acme/other"]) {
      const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/${ref}`), workspaceToken, {
        workspaceRef: ref,
      });
      expect(out).toBeInstanceOf(Response);
      const res = out as Response;
      expect(res.status).toBe(404);
      const payload = await body(res);
      expect(payload.error).toBe("workspace_not_found");
      expect(String(payload.message)).toContain(ref);
    }
  });

  it("keeps the plain lookup for a workspace token with no path", async () => {
    tableRows.workspaces = [{ id: "ws-1", slug: "docs" }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(), workspaceToken);
    expect(out).toEqual({ workspaceId: "ws-1", slug: "docs" });
  });
});
