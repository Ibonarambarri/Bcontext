/**
 * The kinds a workspace's nodes may carry: the core kinds plus the
 * workspace's node record types (0103). One question, asked by every surface
 * that validates a kind where a workspace is in scope — node writes over REST
 * and MCP, saved and ad-hoc view queries.
 *
 * Callers: `@/lib/views/kinds`, the node write paths. Must not break: it
 * reads through the storage it is given and never widens anything; a
 * workspace with no record types answers exactly `NODE_KINDS`.
 */
import { NODE_KINDS } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";

/**
 * Core kinds only until the record type store lands (the business layer API
 * PR); nothing can create a record type before then, so this is exact.
 */
export async function workspaceKinds(storage: Pick<Storage, "workspace">): Promise<string[]> {
  void storage;
  return [...NODE_KINDS];
}
