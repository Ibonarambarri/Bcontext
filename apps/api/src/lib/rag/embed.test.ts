import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embedNode } from "./embed";

const embedMany = vi.fn();
vi.mock("ai", () => ({ embedMany: (args: unknown) => embedMany(args) }));
vi.mock("@/lib/rag", () => ({ resolveEmbeddingModel: () => "nomic-embed-text" }));
vi.mock("./contextualize", async () => {
  const real = await vi.importActual<typeof import("./contextualize")>("./contextualize");
  return {
    ...real,
    contextualizeChunks: async (_doc: unknown, chunks: Array<{ content: string }>) =>
      chunks.map((c) => ({ ...c, context_prefix: "", embedding_input: c.content })),
  };
});
vi.mock("@/lib/telemetry/ai-usage", () => ({ recordAiUsageEvent: () => {} }));

const ORIG_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY;

/** Minimal fake Supabase client covering only the calls embedNode makes. */
function fakeSupabase(node: Record<string, unknown> | null) {
  const deleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const selectMaybeSingle = vi.fn().mockResolvedValue({ data: node, error: null });
  const from = vi.fn((table: string) => {
    if (table === "nodes") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: selectMaybeSingle }),
        }),
      };
    }
    if (table === "embeddings") {
      return { delete: () => ({ eq: deleteEq }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return {
    client: { from } as unknown as SupabaseClient,
    deleteEq,
    selectMaybeSingle,
  };
}

describe("embedNode credential skip", () => {
  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });
  afterEach(() => {
    if (ORIG_GATEWAY_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = ORIG_GATEWAY_KEY;
  });

  it("skips embedding for a credential node and clears any prior chunks", async () => {
    const { client, deleteEq } = fakeSupabase({
      id: "cred-1",
      workspace_id: "ws-1",
      title: "Supabase keys",
      content_md: "Keys for the project.",
      kind: "credential",
    });

    const result = await embedNode(client, "cred-1");

    expect(result).toEqual({ status: "skipped", chunks: 0, reason: "credential" });
    expect(deleteEq).toHaveBeenCalledWith("node_id", "cred-1");
  });

  it("does not take the credential skip path for a non-credential node", async () => {
    // No AI_GATEWAY_API_KEY here on purpose: this isolates the credential
    // branch from the (network-calling) embedding pipeline. If a
    // non-credential node were misrouted into the credential skip, the
    // reason would be "credential"; the real code path instead short
    // circuits earlier with its own distinct reason.
    delete process.env.AI_GATEWAY_API_KEY;
    const { client, selectMaybeSingle } = fakeSupabase({
      id: "doc-1",
      workspace_id: "ws-1",
      title: "Runbook",
      content_md: "",
      kind: "doc",
    });

    const result = await embedNode(client, "doc-1");

    expect(selectMaybeSingle).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "skipped",
      chunks: 0,
      reason: "no AI backend configured",
    });
  });
});

describe("embedNode vector size", () => {
  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    embedMany.mockReset();
  });
  afterEach(() => {
    if (ORIG_GATEWAY_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = ORIG_GATEWAY_KEY;
  });

  /** Fake client that logs table writes and rejects wrong-size vectors on insert, as pgvector does. */
  function recordingClient() {
    const writes: string[] = [];
    const client = {
      from: (table: string) => {
        if (table === "nodes") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "n1", workspace_id: "ws-1", title: "Doc", content_md: "Some body text.", kind: "doc", data: null },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
          delete: () => ({
            eq: async () => {
              writes.push("delete");
              return { error: null };
            },
          }),
          insert: async (rows: Array<{ embedding: number[] }>) => {
            writes.push("insert");
            return rows.some((r) => r.embedding.length !== 1536)
              ? { error: { message: "expected 1536 dimensions" } }
              : { error: null };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, writes };
  }

  it("rejects wrong-size vectors before deleting the node's existing chunks", async () => {
    // an Ollama-style model: 768 dimensions, not the 1536 the column holds
    embedMany.mockResolvedValue({ embeddings: [new Array(768).fill(0.1)], usage: { tokens: 1 } });
    const { client, writes } = recordingClient();

    await expect(embedNode(client, "n1")).rejects.toThrow(/EMBEDDING_MODEL "nomic-embed-text" returned 768-dimensional/);
    expect(writes).toEqual([]); // no delete, no insert: the old rows are untouched
  });

  it("still embeds when the model returns 1536-dimensional vectors", async () => {
    embedMany.mockResolvedValue({ embeddings: [new Array(1536).fill(0.1)], usage: { tokens: 1 } });
    const { client, writes } = recordingClient();

    await expect(embedNode(client, "n1")).resolves.toMatchObject({ status: "embedded", chunks: 1 });
    expect(writes).toEqual(["delete", "insert"]);
  });
});
