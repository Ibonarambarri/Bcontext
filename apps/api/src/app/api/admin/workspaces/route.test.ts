import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Creating a workspace by hand. Two things are load-bearing here: the
 * platform-admin gate runs before anything is written, and a creation
 * answers with a link and sends nothing — the email is its own route, asked
 * for by name.
 *
 * Reading the list is `list.test.ts`, which drives the same route against a
 * fake database; here the library is stubbed, so what is under test is the
 * route's own mapping.
 */
let sessionUser: { id: string; email: string } | null = null;
const created: unknown[] = [];

vi.mock("@/lib/admin/workspaces", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/workspaces")>(
    "@/lib/admin/workspaces",
  );
  return {
    ...actual,
    listAdminWorkspaces: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    createAdminWorkspace: async (input: unknown) => {
      created.push(input);
      return {
        workspace: {
          id: "ws-1",
          slug: "acme",
          name: "Acme",
          created_at: "2026-01-01T00:00:00.000Z",
          member_count: 0,
          pending_invite_count: 1,
          owner_emails: [],
        },
        invite: {
          id: "inv-1",
          email: "ana@acme.test",
          role: "owner",
          url: "https://app.example.com/invite/tok-1",
          expires_at: "2030-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          email_status: null,
          email_sent_at: null,
          email_error: null,
        },
      };
    },
  };
});
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET, POST } from "./route";

const headers = {
  origin: "http://localhost",
  host: "localhost",
  "content-type": "application/json",
};
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );

const asAdmin = () => {
  process.env.ADMIN_EMAILS = "root@example.com";
  sessionUser = { id: "u-0", email: "root@example.com" };
};

afterEach(() => {
  sessionUser = null;
  created.length = 0;
  delete process.env.ADMIN_EMAILS;
});

describe("/api/admin/workspaces", () => {
  it("refuses someone who is not a platform admin", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await post({ name: "Acme", owner_email: "ana@acme.test" })).status).toBe(403);
    expect(created).toEqual([]);
    const list = await GET(
      new Request("http://localhost/api/admin/workspaces", { headers }),
    );
    expect(list.status).toBe(403);
  });

  it("needs an address that is one", async () => {
    asAdmin();
    const res = await post({ name: "Acme", owner_email: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Enter a valid owner email." });
    expect(created).toEqual([]);
  });

  it("creates the workspace and answers with the owner's link", async () => {
    asAdmin();
    const res = await post({ name: "Acme", owner_email: "Ana@Acme.test" });
    expect(res.status).toBe(201);
    expect(created).toEqual([
      {
        name: "Acme",
        slug: undefined,
        ownerEmail: "ana@acme.test",
        role: "owner",
        adminUserId: "u-0",
      },
    ]);
    expect(await res.json()).toMatchObject({
      workspace: { slug: "acme" },
      invite: { url: "https://app.example.com/invite/tok-1", email_status: null },
    });
  });
});
