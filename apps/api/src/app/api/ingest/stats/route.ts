/**
 * GET /api/ingest/stats?workspace_id=<uuid>
 *
 * Aggregate counts of ingest_candidates by status, for the workspace
 * dashboard's "Pending review" figure. A number, not the rows: the badge
 * never needs the candidates' content.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const QuerySchema = z.object({ workspace_id: z.string().uuid() });

const CANDIDATE_STATUSES = ["pending", "reprocess", "accepted", "dismissed"] as const;

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ workspace_id: url.searchParams.get("workspace_id") });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ctx = await openWorkspaceById(req, parsed.data.workspace_id, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const candidates = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  if (storage.backend !== "supabase") {
    return Response.json({ candidates });
  }

  const { data } = await getSupabaseAdmin()
    .from("ingest_candidates")
    .select("status")
    .eq("workspace_id", parsed.data.workspace_id);
  for (const row of data ?? []) {
    if (row.status in candidates) candidates[row.status] = (candidates[row.status] ?? 0) + 1;
  }

  return Response.json({ candidates });
});
