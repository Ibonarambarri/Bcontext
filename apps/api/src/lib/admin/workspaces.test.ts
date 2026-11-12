import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * An instance admin creating a workspace: the row is written bare, and the
 * first owner arrives through an invitation, never a membership pointing at
 * an account that does not exist yet.
 */
type Write = {
  table: string;
  op: "insert" | "update";
  payload: Record<string, unknown>;
  where: Array<[string, unknown]>;
};

const writes: Write[] = [];

const WS = {
  id: "ws-1",
  slug: "acme",
  name: "Acme",
  description: null,
  github_repo: null,
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
};
const INVITE = {
  id: "inv-1",
  workspace_id: WS.id,
  email: "ana@acme.test",
  role: "owner",
  token: "tok-1",
  expires_at: "2030-01-01T00:00:00.000Z",
  accepted_at: null,
  created_at: WS.created_at,
  delivery_state: null,
  delivery_at: null,
  delivery_error: null,
};

function makeAdmin() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let current: Write | null = null;
    for (const k of ["select", "order", "limit", "is", "in", "like"]) b[k] = () => b;
    b.eq = (col: string, val: unknown) => {
      current?.where.push([col, val]);
      return b;
    };
    b.insert = (payload: Record<string, unknown>) => {
      current = { table, op: "insert", payload, where: [] };
      writes.push(current);
      return b;
    };
    b.update = (payload: Record<string, unknown>) => {
      current = { table, op: "update", payload, where: [] };
      writes.push(current);
      return b;
    };
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({
      data: table === "workspaces" ? WS : INVITE,
      error: null,
    });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return b;
  };
  return { from };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@/lib/workspaces/members", () => ({
  createWorkspaceInvite: async () => ({ id: INVITE.id }),
  revokeWorkspaceInvite: async () => undefined,
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createAdminWorkspace } from "./workspaces";

const create = () =>
  createAdminWorkspace({
    name: "Acme",
    ownerEmail: "ana@acme.test",
    role: "owner",
    adminUserId: "u-0",
  });

afterEach(() => {
  writes.length = 0;
});

describe("createAdminWorkspace", () => {
  it("writes the workspace bare and hands it over by invitation", async () => {
    const result = await create();
    expect(result.workspace.slug).toBe("acme");
    expect(result.invite.id).toBe(INVITE.id);
    expect(writes.filter((w) => w.table === "workspaces")).toEqual([
      {
        table: "workspaces",
        op: "insert",
        payload: { slug: "acme", name: "Acme", description: null },
        where: [],
      },
    ]);
    expect(writes.some((w) => w.table === "memberships")).toBe(false);
  });
});
