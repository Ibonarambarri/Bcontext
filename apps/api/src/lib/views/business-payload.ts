/**
 * What `POST /api/views/:id/resolve` returns for views over the business
 * layer, beside the node ids: the records a board/table shows (with their
 * fields and types), a dataset-backed type's rows, a metrics view's summary
 * and chart aggregates, a heatmap's aggregate. Shapes are the contract's
 * `BusinessResolveExtras`; MCP `views(op=resolve)` returns the same.
 *
 * Every read goes through the scoped storage the route opened, so a
 * narrowed principal sees its reach and nothing more; the event and dataset
 * reads carry the workspace id themselves. A part that cannot be computed
 * (no DATABASE_URL in the demo, a dataset deleted under a view) comes back
 * with an `error` string and the rest of the payload still renders.
 *
 * Money in event aggregates: a measure that sums `amount` only counts events
 * in the workspace's reporting currency (no FX, same rule as the rollups),
 * so a GMV line never adds euros to dollars.
 */
import { isCoreKind, type KnowledgeNode } from "@bcontext-dev/contract/types";
import { readRecordFields, type RecordFields, type RecordType } from "@bcontext-dev/contract/business/record-types";
import type { DatasetFilter, DatasetQuery } from "@bcontext-dev/contract/datasets";
import {
  BUSINESS_VIEW_LIMITS,
  HeatmapLayoutSchema,
  MetricsLayoutSchema,
  aggregateRows,
  readEventKey,
  type AggregateResult,
  type AggregateSpec,
  type BusinessResolveExtras,
  type DatasetViewPayload,
  type MetricsViewPayload,
} from "@bcontext-dev/contract/views/business";
import type { RecordRow } from "@bcontext-dev/contract/views/fields";
import type { ResolvedViewQuery, SavedView } from "@bcontext-dev/contract/views/types";
import type { Storage } from "@/lib/storage";
import { getBusinessSettings, listRecordTypes } from "@/lib/business/record-types";
import { getMetricsSummary } from "@/lib/business/summary";
import { readEventsForAggregate } from "@/lib/business/event-reads";
import { queryDataset } from "@/lib/datasets";
import { shownTypes } from "./business-checks";

const RECORD_RENDERERS = new Set(["board", "table", "list"]);

export function viewNeedsBusinessPayload(view: Pick<SavedView, "query" | "presentation">): boolean {
  const renderer = view.presentation.renderer;
  if (renderer === "metrics" || renderer === "heatmap") return true;
  if (view.query.dataset_type) return true;
  return RECORD_RENDERERS.has(renderer) && view.query.kinds.some((kind) => !isCoreKind(kind));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "could not be computed";
}

export async function buildBusinessExtras(
  storage: Storage,
  view: Pick<SavedView, "query" | "presentation">,
  result: ResolvedViewQuery,
  fullRecords?: KnowledgeNode[],
): Promise<BusinessResolveExtras> {
  if (!viewNeedsBusinessPayload(view)) return {};
  const [types, settings] = await Promise.all([listRecordTypes(storage), getBusinessSettings(storage)]);
  const renderer = view.presentation.renderer;
  if (renderer === "metrics") return { metrics: await metricsPayload(storage, view.presentation.layout.metrics, types, settings.currency) };
  if (renderer === "heatmap") {
    const parsed = HeatmapLayoutSchema.safeParse(view.presentation.layout.heatmap);
    if (!parsed.success) return { heatmap: { result: null, error: `layout.heatmap: ${parsed.error.issues[0]?.message ?? "invalid"}` } };
    try {
      return { heatmap: { result: await runAggregate(storage, parsed.data.aggregate, types, settings.currency) } };
    } catch (err) {
      return { heatmap: { result: null, error: message(err) } };
    }
  }
  if (view.query.dataset_type) {
    const dataset = await datasetPayload(storage, view.query, types);
    return dataset ? { dataset } : {};
  }
  const shown = shownTypes(view.query, types);
  if (shown.length === 0) return {};
  const wanted = new Set(result.node_ids);
  const nodes = fullRecords ?? await storage.listNodes({ kinds: shown.map((type) => type.key), limit: 5_000 });
  const rows: RecordRow[] = nodes
    .filter((node) => wanted.has(node.id) && node.workspace_id === storage.workspace.id)
    .map((node) => ({ id: node.id, title: node.title, type: node.kind, fields: readRecordFields(node.data) }));
  return { records: { types: shown, rows, currency: settings.currency } };
}

/** The full nodes of a view's record kinds, read once and shared with the resolver's field filters. */
export async function readViewRecords(storage: Storage, view: Pick<SavedView, "query" | "presentation">): Promise<{ nodes: KnowledgeNode[]; fields: Map<string, RecordFields> } | null> {
  const recordKinds = view.query.kinds.filter((kind) => !isCoreKind(kind));
  if (recordKinds.length === 0 || view.query.dataset_type) return null;
  const nodes = (await storage.listNodes({ kinds: recordKinds, limit: 5_000 })).filter((node) => node.workspace_id === storage.workspace.id);
  return { nodes, fields: new Map(nodes.map((node) => [node.id, readRecordFields(node.data)])) };
}

/* -- dataset-backed rows -------------------------------------------------------- */

function toDatasetFilters(query: SavedView["query"], type: RecordType): DatasetFilter[] {
  const columns = new Set(type.fields.map((field) => field.key));
  const out: DatasetFilter[] = [];
  for (const filter of query.field_filters) {
    if (!columns.has(filter.field)) continue;
    if (filter.op === "empty") out.push({ column: filter.field, op: "is_null", value: filter.value !== false });
    else if (filter.op === "in") out.push({ column: filter.field, op: "in", value: Array.isArray(filter.value) ? (filter.value as Array<string | number>) : [] });
    else out.push({ column: filter.field, op: filter.op, value: filter.value as string | number | boolean | null });
  }
  return out;
}

async function datasetPayload(storage: Storage, query: SavedView["query"], types: readonly RecordType[]): Promise<DatasetViewPayload | null> {
  const type = types.find((candidate) => candidate.key === query.dataset_type && candidate.storage === "dataset");
  if (!type || !type.dataset_node_id) return null;
  const promote_targets = promoteTargets(type, types);
  const datasetQuery: DatasetQuery = {
    schema_version: 1,
    where: toDatasetFilters(query, type),
    limit: BUSINESS_VIEW_LIMITS.maxDatasetRows,
  };
  try {
    const answer = await queryDataset(storage, type.dataset_node_id, datasetQuery);
    const titleField = ["name", "title", "display_name", "email"].find((key) => type.fields.some((field) => field.key === key));
    const rows: RecordRow[] = answer.rows.map((row, index) => {
      const key = typeof row.external_id === "string" || typeof row.external_id === "number" ? String(row.external_id) : `row-${index}`;
      const fields: RecordFields = {};
      for (const field of type.fields) if (field.key in row) fields[field.key] = row[field.key] as RecordFields[string];
      return { id: key, title: titleField && typeof row[titleField] === "string" ? String(row[titleField]) : key, type: type.key, fields };
    });
    return { type, rows, total: answer.row_count, truncated: answer.truncated, promote_targets };
  } catch {
    // No dataset backend (demo), or the dataset was removed under the type:
    // an empty table that says so beats a failed view.
    return { type, rows: [], total: 0, truncated: false, promote_targets };
  }
}

/**
 * Node record types a row can become, best match first: the more of the
 * dataset's fields a type declares, the less a promotion loses.
 */
function promoteTargets(type: RecordType, types: readonly RecordType[]): DatasetViewPayload["promote_targets"] {
  const columns = new Set(type.fields.map((field) => field.key));
  return types
    .filter((candidate) => candidate.storage === "node")
    .map((candidate) => ({ candidate, overlap: candidate.fields.filter((field) => columns.has(field.key)).length }))
    .sort((a, b) => b.overlap - a.overlap || a.candidate.position - b.candidate.position)
    .map(({ candidate }) => ({ key: candidate.key, label: candidate.label }));
}

/* -- metrics and aggregates ------------------------------------------------------ */

async function metricsPayload(storage: Storage, rawLayout: unknown, types: readonly RecordType[], currency: string): Promise<MetricsViewPayload> {
  const parsed = MetricsLayoutSchema.safeParse(rawLayout ?? {});
  const layout = parsed.success ? parsed.data : MetricsLayoutSchema.parse({});
  const summary = await getMetricsSummary(storage).catch(() => null);
  const charts = await Promise.all(layout.charts.map(async (chart, index) => {
    if (!chart.aggregate) return { index, result: null };
    try {
      return { index, result: await runAggregate(storage, chart.aggregate, types, currency) };
    } catch (err) {
      return { index, result: null, error: message(err) };
    }
  }));
  return { summary, charts: charts.filter((chart) => layout.charts[chart.index]?.aggregate) };
}

/** Run one aggregate spec against events or a dataset-backed type's rows. */
export async function runAggregate(
  storage: Storage,
  spec: AggregateSpec,
  types: readonly RecordType[],
  currency: string,
): Promise<AggregateResult> {
  if (spec.source.from === "events") {
    const { rows, truncated } = await readEventsForAggregate(storage, spec.source.types, spec.since ? `${spec.since}T00:00:00Z` : null);
    const sumsAmount = spec.measures.some((measure) => measure.op === "sum" && measure.key === "amount");
    const usable = sumsAmount ? rows.filter((row) => !row.currency || row.currency === currency) : rows;
    return aggregateRows(usable as unknown as Record<string, unknown>[], spec, { read: readEventKey, truncated });
  }
  const recordType = spec.source.record_type;
  const type = types.find((candidate) => candidate.key === recordType && candidate.storage === "dataset");
  if (!type?.dataset_node_id) throw new Error(`\`${recordType}\` is not a dataset-backed record type here`);
  const groupBy = [spec.x.key, ...(spec.y ? [spec.y.key] : [])];
  const where: DatasetFilter[] = (spec.where ?? []).map((filter) => ({
    column: filter.key,
    op: filter.op,
    value: filter.value as DatasetFilter["value"],
  }));
  if (spec.since && spec.x.bucket) where.push({ column: spec.x.key, op: "gte", value: spec.since });
  const answer = await queryDataset(storage, type.dataset_node_id, {
    schema_version: 1,
    where,
    group_by: groupBy,
    aggregate: spec.measures.map((measure) => ({ fn: measure.op === "sum" ? "sum" : "count", ...(measure.key && measure.op === "sum" ? { column: measure.key } : {}), as: measure.as })),
    limit: 1_000,
  });
  // The dataset groups by the raw date; the bucketing (week, month) and the
  // re-summing happen here, which is exact for count and sum.
  return aggregateRows(answer.rows, spec, { preAggregated: true, truncated: answer.truncated });
}
