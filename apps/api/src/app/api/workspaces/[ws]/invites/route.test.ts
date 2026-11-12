import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Inviting from the members screen. The route owns the admin check, a bad
 * address comes back as a 400 the form can show, and creating an invitation
 * sends nothing: the reply carries the link, and emailing it is the separate
 * `POST .../invites/:id/email`.
 */
const state: {
  ctx: unknown;
  created: unknown[];
  fail: string | null;
  sends: number;
} = { ctx: null, created: [], fail: null, sends: 0 };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/workspaces/members", () => ({
  MembersError: class MembersError extends Error {},
  createWorkspaceInvite: async (input: unknown) => {
    if (state.fail) throw new Error(state.fail);
    state.created.push(input);
    return {
      id: "inv-1",
      email: (input as { email: string }).email,
      role: (input as { role: string }).role,
      token: "tok-1",
      url: "http://localhost:3000/invite/tok-1",
      expires_at: "2030-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      email_status: null,
      email_sent_at: null,
      email_error: null,
    };
  },
}));
// The mailer is mocked only to prove it is never reached from here.
vi.mock("@/lib/workspaces/invite-email", () => ({
  sendWorkspaceInviteEmail: async () => {
    state.sends += 1;
    return { status: "sent", error: null, messageId: null };
  },
}));

import { POST } from "./route";

const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "admin-1" },
  storage: { backend, workspace: { id: "ws-1", slug: "acme", name: "Acme" } },
});
const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/workspaces/acme/invites", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ ws: "acme" }) },
  );

afterEach(() => {
  state.ctx = userCtx();
  state.created = [];
  state.fail = null;
  state.sends = 0;
});

describe("POST /api/workspaces/:ws/invites", () => {
  it("rejects an address that is not one", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "nope", role: "editor" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Enter a valid email address." });
    expect(state.created).toEqual([]);
  });

  it("creates the invitation into this workspace, by the caller", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "Ana@Example.com", role: "viewer" });
    expect(res.status).toBe(201);
    expect(state.created).toEqual([
      { workspaceId: "ws-1", email: "ana@example.com", role: "viewer", invitedBy: "admin-1" },
    ]);
    const body = (await res.json()) as { invite: Record<string, unknown> };
    expect(body.invite).toMatchObject({
      id: "inv-1",
      email: "ana@example.com",
      role: "viewer",
      url: "http://localhost:3000/invite/tok-1",
    });
    // The link carries the token; the bare token does not travel twice.
    expect(body.invite).not.toHaveProperty("token");
  });

  it("sends nothing — the link is the deliverable", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "ana@example.com" });
    expect(res.status).toBe(201);
    expect(state.sends).toBe(0);
    expect(await res.json()).toMatchObject({
      invite: { url: "http://localhost:3000/invite/tok-1" },
    });
  });

  it("invites an admin into this workspace like anyone else", async () => {
    state.ctx = userCtx();
    await post({ email: "ana@example.com", role: "admin" });
    expect(state.created).toEqual([
      { workspaceId: "ws-1", email: "ana@example.com", role: "admin", invitedBy: "admin-1" },
    ]);
  });

  it("is a person's action, not a token's", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "agent", workspaceId: "ws-1" } };
    expect((await post({ email: "ana@example.com" })).status).toBe(403);
    expect(state.created).toEqual([]);
  });
});
