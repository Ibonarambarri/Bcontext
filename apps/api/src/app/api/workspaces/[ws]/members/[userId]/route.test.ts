import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Role change and removal on the members screen. The membership write and
 * the grant mirror must stay beside each other — the grant is authoritative,
 * so a role that reached `memberships` alone would be a role nobody actually
 * holds — and a workspace never loses its last owner.
 */
const state: {
  ctx: unknown;
  memberships: Array<{ user_id: string; role: string; created_at: string }>;
  writes: string[];
  synced: Array<[string, string, string | null, unknown]>;
} = { ctx: null, memberships: [], writes: [], synced: [] };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/auth/grant-sync", () => ({
  syncGrantFromMembership: async (ws: string, user: string, role: string | null, opts: unknown) => {
    state.synced.push([ws, user, role, opts]);
  },
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Reads answer with the seeded roster (and no grants, so nobody is revoked);
// writes are recorded as `<table>.<op> <col>=<val>`.
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const read: Record<string, unknown> = {};
      for (const k of ["select", "eq", "neq", "order"]) read[k] = () => read;
      read.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === "memberships" ? state.memberships : [], error: null });
      const chain = (op: string) => ({
        eq: (col: string, val: string) => {
          state.writes.push(`${table}.${op} ${col}=${val}`);
          return chain(op);
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return {
        ...read,
        update: () => chain("update"),
        delete: () => chain("delete"),
      };
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "admin-1" },
  storage: { backend, workspace: { id: "ws-1", slug: "acme" } },
});
const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const params = (userId: string) => ({ params: Promise.resolve({ ws: "acme", userId }) });
const patch = (userId: string, role: string) =>
  PATCH(
    new Request(`http://localhost/api/workspaces/acme/members/${userId}`, { method: "PATCH", headers, body: JSON.stringify({ role }) }),
    params(userId),
  );
const del = (userId: string) =>
  DELETE(new Request(`http://localhost/api/workspaces/acme/members/${userId}`, { method: "DELETE", headers }), params(userId));

const ROSTER = [
  { user_id: "admin-1", role: "owner", created_at: "2026-01-01T00:00:00.000Z" },
  { user_id: "u2", role: "editor", created_at: "2026-01-02T00:00:00.000Z" },
];

afterEach(() => {
  state.ctx = userCtx();
  state.memberships = ROSTER;
  state.writes = [];
  state.synced = [];
});

describe("PATCH /api/workspaces/:ws/members/:userId", () => {
  it("refuses a role outside the four a person can hold", async () => {
    state.ctx = userCtx();
    expect((await patch("u2", "agent")).status).toBe(400);
    expect(state.writes).toEqual([]);
  });

  it("writes the membership and mirrors the grant without reinstating", async () => {
    state.ctx = userCtx();
    state.memberships = ROSTER;
    expect((await patch("u2", "viewer")).status).toBe(200);
    expect(state.writes).toEqual(["memberships.update workspace_id=ws-1", "memberships.update user_id=u2"]);
    // No `reinstate`: re-picking a role for someone whose grant was revoked
    // must not quietly bring them back.
    expect(state.synced).toEqual([["ws-1", "u2", "viewer", undefined]]);
  });

  it("will not demote the last owner", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "user", userId: "u2" } };
    state.memberships = ROSTER;
    const res = await patch("admin-1", "editor");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_owner" });
    expect(state.writes).toEqual([]);
  });

  it("is a person's action, not a token's", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "agent_user", userId: "admin-1" } };
    expect((await patch("u2", "viewer")).status).toBe(403);
  });
});

describe("DELETE /api/workspaces/:ws/members/:userId", () => {
  it("will not remove the caller", async () => {
    state.ctx = userCtx();
    state.memberships = [
      ...ROSTER,
      { user_id: "u3", role: "owner", created_at: "2026-01-03T00:00:00.000Z" },
    ];
    const res = await del("admin-1");
    expect(res.status).toBe(409);
    expect(state.writes).toEqual([]);
    expect(state.synced).toEqual([]);
  });

  it("404s somebody who is not on the roster", async () => {
    state.ctx = userCtx();
    expect((await del("u-stranger")).status).toBe(404);
    expect(state.writes).toEqual([]);
  });

  it("revokes the grant in the same breath as the membership", async () => {
    state.ctx = userCtx();
    expect((await del("u2")).status).toBe(200);
    expect(state.writes).toEqual(["memberships.delete workspace_id=ws-1", "memberships.delete user_id=u2"]);
    expect(state.synced).toEqual([["ws-1", "u2", null, undefined]]);
  });
});
