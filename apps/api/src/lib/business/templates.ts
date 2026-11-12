/**
 * Apply a business template (b2b, b2c, marketplace) to a workspace: create
 * the record types, the datasets behind dataset-backed ones, and the views
 * the template lists — only what is missing.
 *
 * Callers: `POST /api/workspaces/:ws/business/apply-template`,
 * `admin_write(op=apply_business_template)` over MCP, and workspace creation
 * with a `business_model` (`POST /api/workspaces`). All three hold the admin
 * verb before calling.
 *
 * What keeps it safe to run again, and after people edited things — the
 * contract's `planBusinessTemplate` decides, this only executes:
 *   - a record type whose key exists is never touched (fields, labels and
 *     stages are the workspace's own once created);
 *   - a view carrying the template marker (`layout.template`) or the slug of
 *     the template view's name is skipped;
 *   - a dataset-backed type reuses a `data` node with the template's title
 *     and an `external_id` column when a previous run created it and then
 *     failed before the type, so a retry does not leave two "Customers";
 *   - nothing is deleted or overwritten, and one item failing is reported in
 *     `skipped` with its reason while the rest still lands.
 */
import { datasetColumnTypeFor, type BusinessModel } from "@bcontext-dev/contract/business/record-types";
import {
  planBusinessTemplate,
  templateViewPresentation,
  type BusinessTemplateResult,
  type TemplateRecordType,
} from "@bcontext-dev/contract/business/templates";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import type { Storage } from "@/lib/storage";
import { createDataset, describeDatasetNode } from "@/lib/datasets";
import { createView, listViews } from "@/lib/views/store";
import { createRecordType, listRecordTypes } from "./record-types";

export type { BusinessTemplateResult };

function failure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The data node a dataset-backed template type stores its rows in: an
 * existing one this template made (same title, keyed by `external_id`,
 * not bound to another type), else a new empty one with a column per field.
 */
async function datasetFor(
  storage: Storage,
  type: TemplateRecordType,
  boundNodeIds: ReadonlySet<string>,
): Promise<{ node_id: string; reused: boolean }> {
  const title = type.dataset!.title;
  const existing = (await storage.listNodes({ kinds: ["data"], limit: 500 })).find((node) => {
    if (node.title !== title || boundNodeIds.has(node.id)) return false;
    return describeDatasetNode(node)?.columns.some((column) => column.name === "external_id") ?? false;
  });
  if (existing) return { node_id: existing.id, reused: true };
  const columns = [
    { name: "external_id", type: "text" as const },
    ...type.fields.map((field) => ({ name: field.key, type: datasetColumnTypeFor(field.type) })),
  ];
  // A header-only CSV: the dataset starts empty with its columns typed, and
  // the ingest API's keyed upserts fill it.
  const created = await createDataset(storage, {
    title,
    description: type.dataset!.description,
    csv: `${columns.map((column) => column.name).join(",")}\n`,
    columns,
  });
  return { node_id: created.node.id, reused: false };
}

export async function applyBusinessTemplate(
  storage: Storage,
  principal: ViewPrincipal,
  model: BusinessModel,
  createdBy: string | null,
): Promise<BusinessTemplateResult> {
  const result: BusinessTemplateResult = { model, created: { record_types: [], datasets: [], views: [] }, skipped: [] };
  if (model === "product") return result;

  const types = await listRecordTypes(storage);
  // Admin eyes for the plan: a private view someone else owns still holds
  // its slug, and the plan must see it to skip rather than collide.
  const views = await listViews(storage, { ...principal, isAdmin: true });
  const plan = planBusinessTemplate(model, { record_type_keys: types.map((type) => type.key), views });
  result.skipped.push(...plan.skipped);

  const bound = new Set(types.map((type) => type.dataset_node_id).filter((id): id is string => Boolean(id)));
  const failedTypes = new Set<string>();
  for (const type of plan.create_record_types) {
    try {
      const { dataset, ...definition } = type;
      let datasetNodeId: string | null = null;
      if (type.storage === "dataset" && dataset) {
        const target = await datasetFor(storage, type, bound);
        datasetNodeId = target.node_id;
        bound.add(target.node_id);
        result.created.datasets.push({ record_type: type.key, ...target });
      }
      await createRecordType(storage, { ...definition, ...(datasetNodeId ? { dataset_node_id: datasetNodeId } : {}) }, createdBy);
      result.created.record_types.push(type.key);
    } catch (err) {
      failedTypes.add(type.key);
      result.skipped.push({ what: "record_type", key: type.key, reason: failure(err) });
    }
  }

  for (const view of plan.create_views) {
    const needs = [...view.query.kinds ?? [], ...(view.query.dataset_type ? [view.query.dataset_type] : [])];
    const missing = needs.find((key) => failedTypes.has(key));
    if (missing) {
      result.skipped.push({ what: "view", key: view.key, reason: `record type \`${missing}\` was not created` });
      continue;
    }
    try {
      const created = await createView(storage, principal, {
        name: view.name,
        description: view.description,
        visibility: "workspace",
        query: view.query,
        presentation: templateViewPresentation(model, view),
      });
      result.created.views.push({ key: view.key, id: created.id, name: created.name });
    } catch (err) {
      // A record type kept from before may lack a field this view names
      // (the person changed it): the view is skipped, the type is not touched.
      result.skipped.push({ what: "view", key: view.key, reason: failure(err) });
    }
  }
  return result;
}
