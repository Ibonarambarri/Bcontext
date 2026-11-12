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
import { validKindsFor } from "@bcontext-dev/contract/business/record-types";
import type { Storage } from "@/lib/storage";
import { listRecordTypes } from "./record-types";

export async function workspaceKinds(storage: Pick<Storage, "backend" | "workspace">): Promise<string[]> {
  return validKindsFor(await listRecordTypes(storage));
}
