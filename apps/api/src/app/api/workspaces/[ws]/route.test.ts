import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace PATCH is where the settings panel's writes land. What
 * matters: the gate is the workspace's admin verb held by a person, the
 * accent merges into metadata instead of replacing it, and the slug — the
 * workspace's address — is not something a PATCH can move.
 */
const state: {
  ctx: unknown;
  updates: Array<{ table: string; patch: Record<string, unknown>; id: string }>;
  updateError: { code: string; message: string } | null;
} = { ctx: null, updates: [], updateError: null };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          state.updates.push({ table, patch, id });
          const done = { data: state.updateError ? null : { id, ...patch }, error: state.updateError };
          return {
            select: () => ({ single: async () => done }),
            then: (resolve: (v: typeof done) => void) => resolve(done),
          };
        },
      }),
    }),
  }),
}));

import { PATCH } from "./route";

const workspace = {
  id: "ws-1",
  slug: "acme",
  name: "Acme",
  metadata: { accent_gradient: "aurora", something_else: true },
};
const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "u1" },
  storage: { backend, workspace },
});

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/workspaces/acme", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ws: "acme" }) },
  );
}

afterEach(() => {
  state.ctx = userCtx();
  state.updates = [];
  state.updateError = null;
});

describe("PATCH /api/workspaces/:ws", () => {
  it("returns the gate's answer untouched", async () => {
    state.ctx = Response.json({ error: "workspace not found" }, { status: 404 });
    expect((await patch({ name: "x" })).status).toBe(404);
  });

  it("refuses a bearer token, even one holding admin", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "agent", workspaceId: "ws-1" } };
    expect((await patch({ name: "x" })).status).toBe(403);
    expect(state.updates).toEqual([]);
  });

  it("has nothing to write to in the demo store", async () => {
    state.ctx = userCtx("demo");
    expect((await patch({ name: "x" })).status).toBe(400);
  });

  it("rejects an unknown gradient id", async () => {
    state.ctx = userCtx();
    const res = await patch({ accent_gradient: "not-a-gradient" });
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it("merges the accent into metadata rather than replacing it", async () => {
    state.ctx = userCtx();
    const res = await patch({ accent_hue: 200 });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      table: "workspaces",
      id: "ws-1",
      patch: { metadata: { accent_gradient: "aurora", something_else: true, accent_hue: 200 } },
    });
  });

  it("renames the workspace and nothing else", async () => {
    state.ctx = userCtx();
    await patch({ name: "Acme Corp" });
    expect(state.updates).toEqual([
      { table: "workspaces", id: "ws-1", patch: { name: "Acme Corp" } },
    ]);
  });

  it("never moves the slug: it is the workspace's address", async () => {
    state.ctx = userCtx();
    const res = await patch({ slug: "elsewhere" });
    expect(res.status).toBe(200);
    expect(state.updates).toEqual([]);
  });
});
