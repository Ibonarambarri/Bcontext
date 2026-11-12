/**
 * View queries name kinds, and since 0103 the valid kinds are per workspace
 * (core kinds plus record types), which the contract's schema can only check
 * by shape. This is the half that needs the workspace: called when a view is
 * saved and when an ad-hoc query is resolved, so a typo is an error naming
 * the kinds that exist instead of a view that silently matches nothing.
 *
 * Callers: `views/store.ts` (create/update), `POST /api/views/resolve`, the
 * MCP `views`/`views_write` and `nodes(op=list)` tools. A STORED view whose
 * record type was later deleted is not re-checked on resolve: it matches
 * nothing, which is the truth.
 */
import type { Storage } from "@/lib/storage";
import { workspaceKinds } from "@/lib/business/kinds";

export class ViewKindError extends Error {
  constructor(
    public readonly unknown: readonly string[],
    public readonly valid: readonly string[],
  ) {
    super(`kinds: unknown kind${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `\`${k}\``).join(", ")}; valid kinds here: ${valid.join(", ")}`);
    this.name = "ViewKindError";
  }
}

export async function assertViewKindsExist(
  storage: Pick<Storage, "backend" | "workspace">,
  query: { kinds?: readonly string[] } | null | undefined,
): Promise<void> {
  const kinds = query?.kinds ?? [];
  if (kinds.length === 0) return;
  const valid = await workspaceKinds(storage);
  const unknown = kinds.filter((kind) => !valid.includes(kind));
  if (unknown.length > 0) throw new ViewKindError(unknown, valid);
}
