/**
 * Ingest keys — the write-only credentials a SaaS app pushes records and
 * events with.
 *
 *   GET  /api/workspaces/:ws/ingest-keys   → { keys: IngestKey[] }
 *   POST /api/workspaces/:ws/ingest-keys   { name } → { key, record }  (plaintext once)
 *
 * A person with the admin verb, never a bearer token (`openForManagement`):
 * minting a credential is not something an agent should be able to do on
 * its own, the same rule `/api/tokens` follows.
 */
import { CreateIngestKeySchema } from "@bcontext-dev/contract/business/ingest";
import { createIngestKey, listIngestKeys } from "@/lib/business/ingest-keys";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { openForManagement } from "@/lib/workspaces/manage";

type Params = { params: Promise<{ ws: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  return Response.json({ keys: await listIngestKeys(ctx.storage.workspace.id) });
});

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateIngestKeySchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  return Response.json(await createIngestKey(ctx.storage.workspace.id, parsed.data.name, ctx.actor.userId), { status: 201 });
});
