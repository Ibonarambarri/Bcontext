/**
 * The business renderers' calls to the API, browser-side (`fetch("/api/…")`,
 * proxied to the API like every client component's): resolve a view with its
 * business payload, the one light edit a record board makes (a field patch),
 * and "Convert to node" on a dataset row.
 *
 * Callers: `components/business/*`. Must not break: a failed edit reports a
 * status the caller turns into a rollback + toast; a promote endpoint that
 * does not exist on this API (404 without a JSON error body — an older
 * deployment) reports `unavailable`, and the table hides the action instead
 * of offering a button that can never work.
 */
import type { BusinessResolveExtras } from "@bcontext-dev/contract/views/business";
import type { RecordFieldValue } from "@bcontext-dev/contract/business/record-types";
import type { ResolvedViewQuery, SavedView } from "@bcontext-dev/contract/views/types";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

export type BusinessViewPayload = BusinessResolveExtras & { view: SavedView; result: ResolvedViewQuery };

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return response.status === 403 ? "You do not have permission to read this view." : "This view could not be resolved.";
}

export async function resolveBusinessView(workspace: WorkspaceAddress, viewId: string, request: typeof fetch = fetch): Promise<Loaded<BusinessViewPayload>> {
  try {
    const response = await request(`/api/views/${encodeURIComponent(viewId)}/resolve?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status, message: await readError(response) };
    return { ok: true, data: (await response.json()) as BusinessViewPayload };
  } catch {
    return { ok: false, status: 0, message: "This view could not be resolved." };
  }
}

export type FieldPatchOutcome = { status: "ok" } | { status: "invalid"; message: string } | { status: "forbidden" } | { status: "error" };

/** `PATCH /api/nodes/:id { fields }` — the API validates against the record type and names the field on a 400. */
export async function patchRecordFields(
  workspace: WorkspaceAddress,
  nodeId: string,
  fields: Record<string, RecordFieldValue>,
  request: typeof fetch = fetch,
): Promise<FieldPatchOutcome> {
  try {
    const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspaceApiRef(workspace), fields }),
    });
    if (response.ok) return { status: "ok" };
    if (response.status === 400) return { status: "invalid", message: await readError(response) };
    if (response.status === 401 || response.status === 403) return { status: "forbidden" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type PromoteOutcome =
  | { status: "ok"; node_id: string; created: boolean }
  | { status: "unavailable" }
  | { status: "failed"; message: string };

/** `POST /api/nodes/:datasetId/dataset/promote { key, record_type }`. */
export async function promoteRow(
  workspace: WorkspaceAddress,
  datasetNodeId: string,
  key: string,
  recordType: string,
  request: typeof fetch = fetch,
): Promise<PromoteOutcome> {
  try {
    const response = await request(`/api/nodes/${encodeURIComponent(datasetNodeId)}/dataset/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspaceApiRef(workspace), key, record_type: recordType }),
    });
    if (response.ok) {
      const body = (await response.json()) as { node: { id: string }; created: boolean };
      return { status: "ok", node_id: body.node.id, created: body.created };
    }
    if (response.status === 404 || response.status === 405) {
      // The route's own 404s (no such row) carry a JSON error; a route this
      // API does not have answers without one.
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const message = (body as { message?: unknown } | null)?.message;
      if (typeof message !== "string") return { status: "unavailable" };
      return { status: "failed", message };
    }
    return { status: "failed", message: await readError(response) };
  } catch {
    return { status: "failed", message: "The row could not be converted." };
  }
}
