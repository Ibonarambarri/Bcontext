import { describe, expect, it } from "vitest";
import { patchRecordFields, promoteRow } from "./requests";

const ws = { slug: "acme" };

function fake(status: number, body: unknown, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("patchRecordFields", () => {
  it("sends a fields patch and reads a field error", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    expect(await patchRecordFields(ws, "n1", { stage: "won" }, fake(200, { node: {} }, capture))).toEqual({ status: "ok" });
    expect(capture.url).toBe("/api/nodes/n1");
    expect(JSON.parse(String(capture.init!.body))).toMatchObject({ fields: { stage: "won" } });
    expect(await patchRecordFields(ws, "n1", { stage: "x" }, fake(400, { message: "field `stage`: expected one of lead | won" })))
      .toEqual({ status: "invalid", message: "field `stage`: expected one of lead | won" });
    expect(await patchRecordFields(ws, "n1", {}, fake(403, {}))).toEqual({ status: "forbidden" });
  });
});

describe("promoteRow", () => {
  it("hides the action when the API has no promote route", async () => {
    expect(await promoteRow(ws, "d1", "c_1", "account", fake(404, "Not Found"))).toEqual({ status: "unavailable" });
  });

  it("reports the route's own not-found", async () => {
    expect(await promoteRow(ws, "d1", "c_1", "account", fake(404, { error: "not_found", message: "no row with key `c_1`" })))
      .toEqual({ status: "failed", message: "no row with key `c_1`" });
  });

  it("returns the node on success", async () => {
    expect(await promoteRow(ws, "d1", "c_1", "account", fake(201, { node: { id: "n9" }, created: true })))
      .toEqual({ status: "ok", node_id: "n9", created: true });
  });
});
