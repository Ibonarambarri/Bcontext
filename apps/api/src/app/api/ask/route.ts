/**
 * POST /api/ask — "Ask the brain": a question in, a cited answer out.
 *
 *   { "workspace": "acme", "query": "why did we pick pgvector?", "k": 6 }
 *
 * The web's ask box calls it; it is the REST face of the MCP `ask_rag` tool
 * and shares its retrieval (`retrieveScoped`, bounded by the caller's reach)
 * and its synthesis (`@/lib/rag/ask`). Read verb plus `chat:run`, the scope
 * `ask_rag` demands, so a token that may not run the model may not run it
 * here either.
 *
 * What must not break: no model key is a normal answer, not an error. The
 * keyword retriever still finds sources and `synthesis` says `no_model`, so a
 * self-hosted stack without AI gets a search box rather than an error loop.
 * Not streamed: the synthesis is one short `generateText` call.
 */
import { z } from "zod";
import { ASK_MAX_QUERY, type AskResponse } from "@bcontext-dev/contract/ask";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { retrieveScoped } from "@/lib/rag";
import { synthesizeAnswer } from "@/lib/rag/ask";
import { withRoute } from "@/lib/route";
import { viewPrincipal } from "@/lib/views/access";

const Schema = z.object({
  workspace: z.string().min(1),
  query: z.string().trim().min(1).max(ASK_MAX_QUERY),
  k: z.number().int().min(1).max(12).default(6),
});

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  const { workspace, query, k } = parsed.data;

  const ctx = await openWorkspace(req, workspace, "read", { scope: "chat:run" });
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;

  const retrieval = await retrieveScoped(workspace, query, {
    k,
    storage,
    viewPrincipal: await viewPrincipal(actor, storage),
  });
  const { answer, synthesis } = await synthesizeAnswer({
    query,
    hits: retrieval.hits,
    usage: storage.backend === "supabase"
      ? { workspaceId: storage.workspace.id, subjectUserId: actingUserId(actor), surface: "ask_rag" }
      : null,
  });

  const response: AskResponse = {
    query,
    answer,
    synthesis,
    sources: retrieval.hits.map((hit, index) => ({
      n: index + 1,
      node_id: hit.node_id,
      title: hit.title,
      kind: hit.kind,
      block_id: hit.block_id,
      snippet: hit.content?.slice(0, 280) ?? null,
      ...(hit.stale ? { stale: true } : {}),
      ...(hit.superseded_by ? { superseded_by: hit.superseded_by } : {}),
    })),
  };
  return Response.json(response);
});
