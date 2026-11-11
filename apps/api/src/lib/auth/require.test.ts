import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The bearer-token branch of the auth gate: an unknown token is a 401, but a
 * token store that cannot answer is a 503 with Retry-After. Answering 401 for
 * the latter made MCP clients drop a valid token and restart OAuth while
 * PostgREST's pool was stuck.
 */
let verify: () => Promise<unknown> = async () => null;

vi.mock("./tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tokens")>();
  return { ...actual, verifyToken: () => verify() };
});
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { gate } from "./require";
import { TokenLookupUnavailableError } from "./tokens";

const request = () =>
  new Request("http://localhost/api/anything", {
    headers: { authorization: "Bearer bctx_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq" },
  });

afterEach(() => {
  verify = async () => null;
});

describe("gate with a bearer token", () => {
  it("is 401 invalid_token when the token is not found", async () => {
    verify = async () => null;
    const res = await gate(request());
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "invalid_token" });
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("is 503 upstream_unavailable with Retry-After when the lookup fails", async () => {
    verify = async () => {
      throw new TokenLookupUnavailableError("api_tokens", {
        code: "PGRST003",
        message: "Timed out acquiring connection from connection pool.",
      });
    };
    const res = await gate(request());
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "upstream_unavailable" });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(r.headers.get("www-authenticate")).toBeNull();
  });

  it("does not downgrade a lookup failure to anonymous on allowAnonymous routes", async () => {
    verify = async () => {
      throw new TokenLookupUnavailableError("api_tokens", new Error("fetch failed"));
    };
    const res = await gate(request(), undefined, { allowAnonymous: true });
    expect((res as Response).status).toBe(503);
  });

  it("lets unexpected errors propagate", async () => {
    verify = async () => {
      throw new Error("bug");
    };
    await expect(gate(request())).rejects.toThrow("bug");
  });
});
