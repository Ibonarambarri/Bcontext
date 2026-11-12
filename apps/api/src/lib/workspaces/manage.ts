/**
 * The gate every members / invitations / usage route opens with: the
 * workspace through `openWorkspace` with the given verb, held by a person
 * (session cookie), on the Supabase backend.
 *
 * Called by the routes under `/api/workspaces/:ws/{members,invites,usage}`.
 * A bearer token never manages people from here — an agent that hands out
 * access uses `grant_access` / `invite` over MCP, which speak verbs and
 * reach — and the demo store has no roster to manage. Must not break: the
 * workspace is resolved and authorised by `openWorkspace` and nothing else.
 */
import { openWorkspace, type WorkspaceContext } from "@/lib/auth/workspace";
import type { Verb } from "@/lib/auth/grants";
import { MembersError } from "@/lib/workspaces/members";

export type ManagedWorkspace = WorkspaceContext & { actor: { kind: "user"; userId: string } };

export async function openForManagement(
  req: Request,
  ws: string,
  verb: Verb = "admin",
): Promise<ManagedWorkspace | Response> {
  const ctx = await openWorkspace(req, ws, verb, verb === "read" ? { scope: null } : {});
  if (ctx instanceof Response) return ctx;
  if (ctx.actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (ctx.storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Members and invitations need Supabase." },
      { status: 400 },
    );
  }
  return ctx as ManagedWorkspace;
}

/** A `MembersError` as the JSON reply it stands for; anything else rethrows. */
export function membersErrorResponse(err: unknown): Response {
  if (err instanceof MembersError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  throw err;
}
