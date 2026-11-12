import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/health` must report the data path (PostgREST through the service-role
 * client) separately from the auth/db check: in production the db check said
 * "ok" for hours while every PostgREST request timed out.
 */
let restResult: () => Promise<{ error: unknown }> = async () => ({ error: null });
let lastSignal: AbortSignal | undefined;

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => {
    const builder = {
      select: () => builder,
      limit: () => builder,
      abortSignal: (signal: AbortSignal) => {
        lastSignal = signal;
        return restResult();
      },
    };
    return { from: () => builder };
  },
}));

import { GET } from "./route";

const ENV = {
  SUPABASE_URL: "http://kong:8000",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.unstubAllGlobals();
  restResult = async () => ({ error: null });
  lastSignal = undefined;
});

describe("GET /api/health", () => {
  it("is 200 with db and rest ok", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "ok", rest: "ok" });
    // The probe is bounded: a hung PostgREST must not hang the health check.
    expect(lastSignal).toBeInstanceOf(AbortSignal);
  });

  it("is 503 with rest down when PostgREST returns an error", async () => {
    restResult = async () => ({
      error: { code: "PGRST003", message: "Timed out acquiring connection from connection pool." },
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", db: "ok", rest: "down" });
  });

  it("is 503 with rest down when the request throws", async () => {
    restResult = async () => {
      throw new Error("fetch failed");
    };
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ rest: "down" });
  });

  it("skips the rest check without a service-role key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ db: "ok", rest: "skipped" });
  });

  it("skips both checks without Supabase", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "skipped", rest: "skipped" });
  });
});
