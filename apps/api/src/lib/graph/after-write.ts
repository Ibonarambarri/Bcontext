/**
 * What happens right after a node is written — the one hook both storage
 * backends call, so REST, MCP and every other write path get it for free
 * without each one remembering to.
 *
 * Today that is entity linking (no LLM): `references` edges to the `entity`
 * nodes the text names (see `entity-linker.ts`).
 *
 * Fire-and-forget by contract. The write has already succeeded when this
 * runs; nothing here may throw into it, slow it down, or be awaited by it.
 * Every failure is logged and dropped.
 */
import { log } from "@bcontext-dev/contract/log";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";

export interface AfterNodeWriteOpts {
  created: boolean;
  /** Title or body changed (metadata-only updates skip the sweep). */
  contentChanged: boolean;
}

/** The awaited form, for tests and for callers that want the outcome. */
export async function runAfterNodeWrite(
  storage: Storage,
  node: KnowledgeNode,
  opts: AfterNodeWriteOpts,
): Promise<{ linked: string[] }> {
  const out = { linked: [] as string[] };
  if (!opts.created && !opts.contentChanged) return out;

  try {
    const { linkEntities } = await import("./entity-linker");
    out.linked = (await linkEntities(storage, node)).linked;
  } catch (err) {
    log.warn("graph.after_write.entity_linking_failed", {
      workspace_id: storage.workspace.id,
      node_id: node.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

/** Fire-and-forget form for the write path: never throws, never delays the response. */
export function afterNodeWrite(storage: Storage, node: KnowledgeNode, opts: AfterNodeWriteOpts): void {
  void runAfterNodeWrite(storage, node, opts).catch((err) => {
    log.warn("graph.after_write.failed", {
      workspace_id: storage.workspace.id,
      node_id: node.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
