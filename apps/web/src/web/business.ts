/**
 * The business layer's server-side reads: the workspace's business model and
 * currency, its record types, and the metrics summary.
 *
 * Who calls it: the workspace layout (model → sidebar), the overview page
 * (summary → KPI dashboard) and the node page (record types → the record
 * header and the 360 layout). Each read is `React.cache`d by slug so the
 * layout and the page share one API call per request, as `@/web/workspace`
 * does for the node index.
 *
 * Must not break: a workspace whose API does not answer these routes (an
 * older API, the demo backend, a 404 for a viewer) is a `product` workspace
 * with no record types and no metrics. The business layer is an addition;
 * its absence never takes a page down.
 */
import { cache } from "react";
import { log } from "@bcontext-dev/contract/log";
import type { MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import type { BusinessSettings, RecordType } from "@bcontext-dev/contract/business/record-types";
import { apiJson } from "@/web/api-client";
import {
  businessPaths,
  readBusinessSettings,
  readRecordTypes,
  readRecords,
} from "@/lib/business/endpoints";
import type { SubjectEvent, SubjectEventsResponse } from "@bcontext-dev/contract/business/events";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { WorkspaceAddress } from "@/web/workspace-url";

export const PRODUCT_SETTINGS: BusinessSettings = { business_model: "product", currency: "EUR" };

/** Any failure is "no business layer here", logged once so it is not silent. */
async function guarded<T>(what: string, slug: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    log.warn("business.read_failed", { what, ws: slug, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

const settingsBySlug = cache((slug: string) =>
  guarded("settings", slug, async () => readBusinessSettings(await apiJson(businessPaths.settings(slug))) ?? PRODUCT_SETTINGS, PRODUCT_SETTINGS),
);

const recordTypesBySlug = cache((slug: string) =>
  guarded("record_types", slug, async () => readRecordTypes(await apiJson(businessPaths.recordTypes(slug))), [] as RecordType[]),
);

const summaryBySlug = cache((slug: string) =>
  guarded<MetricsSummary | null>("metrics_summary", slug, () => apiJson<MetricsSummary>(businessPaths.metricsSummary(slug)), null),
);

export function getBusinessSettings(ws: WorkspaceAddress): Promise<BusinessSettings> {
  return settingsBySlug(ws.slug);
}

export function listRecordTypes(ws: WorkspaceAddress): Promise<RecordType[]> {
  return recordTypesBySlug(ws.slug);
}

export function getMetricsSummary(ws: WorkspaceAddress): Promise<MetricsSummary | null> {
  return summaryBySlug(ws.slug);
}

/** How many records of one type a page reads at most. The overview lists the top few. */
export const RECORDS_READ_LIMIT = 500;

const recordsBySlug = cache((slug: string, type: string) =>
  guarded("records", slug, async () => readRecords(await apiJson(businessPaths.records(slug, type, RECORDS_READ_LIMIT))), [] as KnowledgeNode[]),
);

/** A node record type's records, with their fields; [] for dataset types or when unavailable. */
export function listRecords(ws: WorkspaceAddress, type: string): Promise<KnowledgeNode[]> {
  return recordsBySlug(ws.slug, type);
}

/** A subject's events, newest first as the API returns them; [] when unavailable. */
export function listSubjectEvents(
  ws: WorkspaceAddress,
  subjectType: string,
  subjectId: string,
  limit = 100,
): Promise<SubjectEvent[]> {
  return guarded(
    "events",
    ws.slug,
    async () => (await apiJson<SubjectEventsResponse>(businessPaths.events(ws, { subjectType, subjectId, limit }))).events ?? [],
    [],
  );
}
