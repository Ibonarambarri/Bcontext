import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The invite link's preview: readable without a session, because the person
 * has not signed in yet, and never echoing the token or distinguishing an
 * expired link from a made-up one.
 */
const state: { gate: unknown; invite: unknown } = { gate: null, invite: null };

vi.mock("@/lib/auth/require", () => ({
  gate: async (_req: Request, _scope: unknown, opts?: { allowAnonymous?: boolean }) => {
    state.gate = opts;
    return { kind: "demo" };
  },
}));
vi.mock("@/lib/workspaces/members", () => ({
  findInviteByToken: async () => state.invite,
}));

import { GET } from "./route";

const get = (token: string) =>
  GET(new Request(`http://localhost/api/invites/${token}`), { params: Promise.resolve({ token }) });

afterEach(() => {
  state.gate = null;
  state.invite = null;
});

describe("GET /api/invites/:token", () => {
  it("lets an anonymous caller through the gate", async () => {
    state.invite = null;
    await get("tok");
    expect(state.gate).toEqual({ allowAnonymous: true });
  });

  it("404s a missing, expired or accepted token alike", async () => {
    state.invite = null;
    const res = await get("tok");
    expect(res.status).toBe(404);
  });

  it("returns what the page shows, and not the token", async () => {
    state.invite = {
      id: "inv-1",
      email: "ana@example.com",
      role: "editor",
      token: "tok",
      expires_at: "2030-01-01T00:00:00.000Z",
      accepted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      workspace_id: "ws-1",
      workspace_slug: "acme",
      workspace_name: "Acme",
    };
    const res = await get("tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invite: {
        email: "ana@example.com",
        role: "editor",
        workspace_name: "Acme",
        workspace_slug: "acme",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    });
  });
});
