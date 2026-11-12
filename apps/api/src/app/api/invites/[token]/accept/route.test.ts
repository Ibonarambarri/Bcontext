import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Accepting needs a person — the grant is born with a principal to attach it
 * to — and the answer names the one workspace the invitation was for, which
 * is where the page lands the person.
 */
const state: {
  gate: unknown;
  invite: unknown;
  result: unknown;
  accepted: Array<[string, unknown]>;
} = { gate: null, invite: null, result: null, accepted: [] };

vi.mock("@/lib/auth/require", () => ({
  gate: async () => state.gate,
}));
vi.mock("@/lib/auth/invitations", () => ({
  acceptInvitation: async (token: string, user: unknown) => {
    state.accepted.push([token, user]);
    return state.result;
  },
}));
vi.mock("@/lib/workspaces/members", () => ({
  findInviteByToken: async () => state.invite,
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "ana@example.com" } } }) },
  }),
}));

import { POST } from "./route";

const post = (token: string) =>
  POST(
    new Request(`http://localhost/api/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ token }) },
  );

afterEach(() => {
  state.gate = { kind: "user", userId: "u1" };
  state.invite = { workspace_id: "ws-1", workspace_slug: "acme" };
  state.result = { workspaceSlug: "acme" };
  state.accepted = [];
});

describe("POST /api/invites/:token/accept", () => {
  it("needs a person, not a token", async () => {
    state.gate = { kind: "agent_user", userId: "u1" };
    expect((await post("tok")).status).toBe(401);
    expect(state.accepted).toEqual([]);
  });

  it("404s before touching a token that leads nowhere", async () => {
    state.gate = { kind: "user", userId: "u1" };
    state.invite = null;
    expect((await post("tok")).status).toBe(404);
    expect(state.accepted).toEqual([]);
  });

  it("accepts as the signed-in person and lands them in the workspace they were invited to", async () => {
    state.gate = { kind: "user", userId: "u1" };
    const res = await post("tok");
    expect(res.status).toBe(200);
    expect(state.accepted).toEqual([["tok", { id: "u1", email: "ana@example.com" }]]);
    expect(await res.json()).toEqual({ workspaceSlug: "acme" });
  });

  it("surfaces a refusal as a 400 with the reason", async () => {
    state.gate = { kind: "user", userId: "u1" };
    state.result = { error: "This invitation was sent to bob@example.com. Sign in with that email to accept." };
    const res = await post("tok");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invite_rejected", message: expect.stringContaining("bob@example.com") });
  });
});
