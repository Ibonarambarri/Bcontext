/**
 * The worker side of the rollup: load a workspace's events, compute, replace.
 *
 * Callers: the `business.rollup` job (one workspace, enqueued by the events
 * route with a singleton key per workspace so a burst of ingests is one run)
 * and `business.rollup-all` (nightly; re-enqueues every workspace with
 * events, so a lost enqueue — the API's enqueue fails open — costs at most a
 * day of staleness). Acts as the system: there is no principal on a job, so
 * the storage is resolved by id and never leaves this module.
 */
import { log } from "@bcontext-dev/contract/log";
import { getStorageById } from "@/lib/storage";
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_BUSINESS_ROLLUP } from "@/lib/queue/queues";
import { loadRollupEvents, replaceRollups, workspacesWithEvents } from "./events";
import { getBusinessSettings } from "./record-types";
import { computeRollups } from "./rollup";

/** Debounce: events arriving within this window share one rollup run. */
const ROLLUP_DEBOUNCE_SECONDS = 30;

export async function runBusinessRollup(workspaceId: string): Promise<Record<string, unknown>> {
  const storage = await getStorageById(workspaceId);
  if (!storage) return { skipped: "workspace not found" };
  const settings = await getBusinessSettings(storage);
  const events = await loadRollupEvents(storage);
  const { rows, ignored } = computeRollups(events, { currency: settings.currency, businessModel: settings.business_model });
  await replaceRollups(storage, rows);
  if (ignored > 0) {
    log.info("business.rollup.ignored_currency", { workspace_id: workspaceId, ignored, currency: settings.currency });
  }
  return { workspace_id: workspaceId, events: events.length, rows: rows.length, ignored_currency: ignored };
}

export async function enqueueAllRollups(): Promise<Record<string, unknown>> {
  const ids = await workspacesWithEvents();
  for (const id of ids) await enqueueBusinessRollup(id);
  return { enqueued: ids.length };
}

/** Ask for a rollup of one workspace soon; repeated asks within the window collapse. */
export async function enqueueBusinessRollup(workspaceId: string): Promise<string | null> {
  return enqueue(
    QUEUE_BUSINESS_ROLLUP,
    { workspace_id: workspaceId },
    { singletonKey: workspaceId, singletonSeconds: ROLLUP_DEBOUNCE_SECONDS, startAfter: ROLLUP_DEBOUNCE_SECONDS },
  );
}
