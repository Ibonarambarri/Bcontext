/**
 * The HTTP edge of the business layer: what the ingest routes and the admin
 * routes share — error mapping, and the record upsert that `PUT` (one) and
 * `POST` (a batch) both are.
 *
 * Callers: the routes under `/api/workspaces/:ws/{records,events,record-types,
 * business,metrics}`. Must not break: an ingest response echoes only what
 * the sender sent and what it caused (statuses, node ids) — never another
 * record's data, since an ingest key may not read.
 */
import type { RecordBatchResponse, RecordUpsertResult } from "@bcontext-dev/contract/business/ingest";
import { changePayload } from "@bcontext-dev/contract/changes";
import { record as recordActivity } from "@/lib/activity";
import { DatasetError, datasetErrorStatus } from "@/lib/datasets";
import type { Storage } from "@/lib/storage";
import { BusinessBackendError } from "./events";
import { RecordTypeError, getRecordType, recordTypeErrorStatus } from "./record-types";
import { RecordWriteError, recordWriteErrorStatus, upsertDatasetRecords, upsertNodeRecord, type RecordUpsertInput } from "./records";

/** Business errors → HTTP; null means "not ours, let it be a 500". */
export function businessErrorResponse(err: unknown): Response | null {
  if (err instanceof RecordTypeError) {
    return Response.json({ error: err.code, message: err.message }, { status: recordTypeErrorStatus(err) });
  }
  if (err instanceof RecordWriteError) {
    return Response.json({ error: err.code, message: err.message }, { status: recordWriteErrorStatus(err) });
  }
  if (err instanceof DatasetError) {
    return Response.json({ error: err.code, message: err.message }, { status: datasetErrorStatus(err.code) });
  }
  if (err instanceof BusinessBackendError) {
    return Response.json({ error: "unsupported_backend", message: err.message }, { status: 501 });
  }
  return null;
}

/**
 * Upsert records of one type by external id. A type that does not exist is
 * a 404 naming it; a record that fails validation is reported in its slot
 * and does not fail the batch — a sender syncing 500 customers should not
 * lose 499 to one bad email.
 */
export async function ingestRecords(
  storage: Storage,
  typeKey: string,
  inputs: readonly RecordUpsertInput[],
): Promise<RecordBatchResponse | Response> {
  const type = await getRecordType(storage, typeKey);
  if (!type) {
    return Response.json(
      { error: "unknown_record_type", message: `no record type \`${typeKey}\` in this workspace; an admin defines it first` },
      { status: 404 },
    );
  }
  let results: RecordUpsertResult[];
  if (type.storage === "dataset") {
    results = await upsertDatasetRecords(storage, type, inputs);
  } else {
    results = [];
    for (const input of inputs) {
      const outcome = await upsertNodeRecord(storage, type, input);
      const { node, before, ...result } = outcome;
      results.push(result);
      if (node && (result.status === "created" || result.status === "updated")) {
        recordActivity(storage.workspace.slug, result.status === "created" ? "create" : "update", node.id, node.title, node.kind, {
          actorKind: "system",
          payload: changePayload({ before: before ?? null, after: node, via: "ingest", source: `ingest:${type.key}` }),
        });
      }
    }
  }
  const count = (status: RecordUpsertResult["status"]) => results.filter((result) => result.status === status).length;
  return {
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    invalid: count("invalid"),
    results,
  };
}
