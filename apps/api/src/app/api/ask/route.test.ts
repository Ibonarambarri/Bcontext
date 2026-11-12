import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResponse } from "@bcontext-dev/contract/ask";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { POST } from "./route";

function ask(body: unknown) {
  return POST(new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/ask", () => {
  // A self-hosted stack with no model key is the case this route must get
  // right: sources from the keyword retriever, and a status, never an error.
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers with numbered sources and no_model when no AI is configured", async () => {
    const workspace = createWorkspace({ name: "Ask", slug: `ask-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const node = await storage.createNode({ title: "Pgvector decision", kind: "decision", parent_id: null, content_md: "We picked pgvector for retrieval." });

    const response = await ask({ workspace: workspace.slug, query: "pgvector retrieval" });
    expect(response.status).toBe(200);
    const body = await response.json() as AskResponse;
    expect(body.answer).toBeNull();
    expect(body.synthesis).toBe("no_model");
    expect(body.sources[0]).toMatchObject({ n: 1, node_id: node.id, title: "Pgvector decision", kind: "decision" });
  });

  it("says no_hits when nothing matches", async () => {
    const workspace = createWorkspace({ name: "Ask empty", slug: `ask-empty-${Date.now()}-${Math.random()}` });
    const body = await (await ask({ workspace: workspace.slug, query: "anything at all" })).json() as AskResponse;
    expect(body).toMatchObject({ answer: null, synthesis: "no_hits", sources: [] });
  });

  it("rejects an empty question", async () => {
    const workspace = createWorkspace({ name: "Ask bad", slug: `ask-bad-${Date.now()}-${Math.random()}` });
    expect((await ask({ workspace: workspace.slug, query: "   " })).status).toBe(400);
  });
});
