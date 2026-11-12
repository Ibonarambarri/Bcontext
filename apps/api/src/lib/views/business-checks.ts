/**
 * The workspace half of validating a view over record types: the contract
 * checks shapes, this checks names against the workspace's record types —
 * that a `dataset_type` is a dataset-backed type, that every field a filter
 * or a `field:<key>` column names is declared by a type the view shows, and
 * that a metrics/heatmap layout parses and reads types that exist.
 *
 * Callers: `views/store.ts` on create/update (so REST and MCP `views_write`
 * both get it) and `POST /api/views/resolve` for ad-hoc queries. A failure
 * is a `ViewDefinitionError`, a `ViewKindError` subclass, so every surface
 * that already maps a bad kind to a 400 / an MCP error text maps this too,
 * with a message naming what does exist.
 *
 * Not re-checked on resolve of a STORED view: a field removed from a type
 * later makes the column empty and the filter match nothing, which is the
 * truth — refusing to open the view would hide every other column too.
 */
import { NODE_KINDS } from "@bcontext-dev/contract/types";
import type { RecordType } from "@bcontext-dev/contract/business/record-types";
import { businessLayoutIssues, layoutDatasetTypes } from "@bcontext-dev/contract/views/business";
import { recordViewFieldRefs } from "@bcontext-dev/contract/views/fields";
import { normalizeViewPresentation, normalizeViewQuery, type ViewPresentation, type ViewQuery } from "@bcontext-dev/contract/views/schema";
import type { Storage } from "@/lib/storage";
import { listRecordTypes } from "@/lib/business/record-types";
import { ViewKindError, assertViewKindsExist } from "./kinds";

export class ViewDefinitionError extends ViewKindError {
  constructor(message: string, valid: readonly string[] = []) {
    super([], valid);
    this.message = message;
    this.name = "ViewDefinitionError";
  }
}

type Scoped = Pick<Storage, "backend" | "workspace">;

/**
 * Everything about a view that needs the workspace. `presentation` is
 * optional: an ad-hoc resolve has only a query.
 */
export async function assertViewAgainstWorkspace(
  storage: Scoped,
  rawQuery: unknown,
  rawPresentation?: unknown,
): Promise<void> {
  const query = rawQuery === undefined ? null : normalizeViewQuery(rawQuery);
  const presentation = rawPresentation === undefined ? null : normalizeViewPresentation(rawPresentation);
  if (query) await assertViewKindsExist(storage, query);
  const needsTypes = Boolean(
    query?.dataset_type || query?.field_filters.length || (presentation && (recordViewFieldRefs(presentation).length || layoutDatasetTypes(presentation).length)),
  );
  if (presentation) {
    const issues = businessLayoutIssues(presentation);
    if (issues.length > 0) throw new ViewDefinitionError(`presentation: ${issues.join("; ")}`);
  }
  if (!needsTypes) return;
  const types = await listRecordTypes(storage);
  if (query) checkQuery(query, types);
  if (presentation) checkPresentation(presentation, query, types);
}

function datasetTypes(types: readonly RecordType[]): RecordType[] {
  return types.filter((type) => type.storage === "dataset");
}

function checkQuery(query: ViewQuery, types: readonly RecordType[]): void {
  if (query.dataset_type) {
    const type = types.find((candidate) => candidate.key === query.dataset_type);
    if (!type || type.storage !== "dataset") {
      const valid = datasetTypes(types).map((candidate) => candidate.key);
      throw new ViewDefinitionError(
        `dataset_type: \`${query.dataset_type}\` is not a dataset-backed record type here` +
          (valid.length ? `; dataset-backed types: ${valid.join(", ")}` : "; this workspace has none"),
        valid,
      );
    }
  }
  if (query.field_filters.length > 0) {
    const shown = shownTypes(query, types);
    const declared = new Set(shown.flatMap((type) => type.fields.map((field) => field.key)));
    const unknown = query.field_filters.map((filter) => filter.field).filter((key) => !declared.has(key));
    if (shown.length === 0) {
      throw new ViewDefinitionError("field_filters need `kinds` naming record types (or a `dataset_type`): core kinds have no fields");
    }
    if (unknown.length > 0) {
      throw new ViewDefinitionError(
        `field_filters: ${unknown.map((key) => `\`${key}\``).join(", ")} ${unknown.length > 1 ? "are not fields" : "is not a field"} of ${shown.map((type) => type.key).join(", ")} (fields: ${[...declared].join(", ") || "none"})`,
        [...declared],
      );
    }
  }
}

function checkPresentation(presentation: ViewPresentation, query: ViewQuery | null, types: readonly RecordType[]): void {
  const refs = recordViewFieldRefs(presentation);
  if (refs.length > 0 && query) {
    const shown = shownTypes(query, types);
    const declared = new Set(shown.flatMap((type) => type.fields.map((field) => field.key)));
    const unknown = refs.filter((key) => !declared.has(key));
    if (unknown.length > 0) {
      throw new ViewDefinitionError(
        `presentation: ${unknown.map((key) => `field:${key}`).join(", ")} ${shown.length ? `not declared by ${shown.map((type) => type.key).join(", ")}` : "needs the query to name record types"} (fields: ${[...declared].join(", ") || "none"})`,
        [...declared],
      );
    }
  }
  const valid = datasetTypes(types).map((type) => type.key);
  const missing = layoutDatasetTypes(presentation).filter((key) => !valid.includes(key));
  if (missing.length > 0) {
    throw new ViewDefinitionError(
      `presentation: ${missing.map((key) => `\`${key}\``).join(", ")} is not a dataset-backed record type here` + (valid.length ? ` (dataset-backed types: ${valid.join(", ")})` : ""),
      valid,
    );
  }
}

/** The record types a view shows: its dataset type, or its non-core kinds in query order. */
export function shownTypes(query: Pick<ViewQuery, "kinds" | "dataset_type">, types: readonly RecordType[]): RecordType[] {
  if (query.dataset_type) return types.filter((type) => type.key === query.dataset_type && type.storage === "dataset");
  const core = new Set<string>(NODE_KINDS);
  return query.kinds
    .filter((kind) => !core.has(kind))
    .map((kind) => types.find((type) => type.key === kind && type.storage === "node"))
    .filter((type): type is RecordType => Boolean(type));
}
