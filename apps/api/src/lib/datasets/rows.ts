/**
 * The row table, and the only module that names it.
 *
 * Rows live in `public.dataset_rows` (migration 0086): `(node_id, idx)` is the
 * primary key, `workspace_id` is copied from the node and guarded by a
 * composite foreign key, and `data` is one jsonb object per row with its
 * values already typed.
 *
 * They are reached through `pg` rather than PostgREST because the query DSL
 * compiles to real SQL — typed comparisons, group-by, aggregates — and none of
 * that is expressible through the REST client. The pool is the one the job
 * runtime already owns (`@/lib/queue/db`), so this adds no second connection
 * story; `DATABASE_URL` is set on `bcontext-api` in production for the
 * realtime LISTEN, and datasets now depend on it too.
 */
import { DATASET_MAX_ROWS } from "@bcontext-dev/contract/datasets";
import { getPool, hasDatabaseUrl } from "@/lib/queue/db";
import { DatasetError } from "./errors";
import type { CellValue } from "./values";

export const DATASET_ROWS_TABLE = "public.dataset_rows";

/** The address of one dataset. Every statement below carries both halves. */
export interface DatasetTarget {
  nodeId: string;
  workspaceId: string;
}

export function datasetRowsAvailable(): boolean {
  return hasDatabaseUrl();
}

function requirePool() {
  if (!datasetRowsAvailable()) {
    throw new DatasetError(
      "unsupported_backend",
      "datasets need a direct database connection (DATABASE_URL); this process has none",
    );
  }
  return getPool();
}

export async function runDatasetSql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const result = await requirePool().query(text, values as unknown[]);
  return result.rows as T[];
}

/** Rows in one dataset, and the highest index used. */
export async function readRowStats(target: DatasetTarget): Promise<{ count: number; maxIdx: number }> {
  const rows = await runDatasetSql<{ count: string | number; max_idx: number | null }>(
    `select count(*)::int as count, max(idx) as max_idx from ${DATASET_ROWS_TABLE}` +
      ` where node_id = $1::uuid and workspace_id = $2::uuid`,
    [target.nodeId, target.workspaceId],
  );
  const row = rows[0];
  return { count: Number(row?.count ?? 0), maxIdx: row?.max_idx ?? -1 };
}

/**
 * Append rows starting at `startIdx`.
 *
 * The whole batch travels as ONE jsonb parameter rather than four placeholders
 * per row: 5.000 rows would otherwise be 20.000 bind parameters and a
 * statement nobody can read in a log.
 */
export async function insertRows(
  target: DatasetTarget,
  startIdx: number,
  rows: readonly Record<string, CellValue>[],
  exec: (text: string, values: unknown[]) => Promise<unknown> = (text, values) =>
    runDatasetSql(text, values),
): Promise<void> {
  if (rows.length === 0) return;
  const last = startIdx + rows.length - 1;
  if (last >= DATASET_MAX_ROWS) {
    // The CHECK on `idx` in 0086 is the net underneath; its message is a
    // constraint name. This is the one a caller can act on.
    throw new DatasetError(
      "too_many_rows",
      `this write would reach row index ${last}; a dataset holds at most ${DATASET_MAX_ROWS} rows. ` +
        `Use op=replace_rows with the data you want, or split the dataset.`,
    );
  }
  const batch = rows.map((data, offset) => ({ idx: startIdx + offset, data }));
  await exec(
    `insert into ${DATASET_ROWS_TABLE} (node_id, workspace_id, idx, data)` +
      ` select $1::uuid, $2::uuid, t.idx, t.data` +
      ` from jsonb_to_recordset($3::jsonb) as t(idx int, data jsonb)`,
    [target.nodeId, target.workspaceId, JSON.stringify(batch)],
  );
}

async function deleteAllRows(
  target: DatasetTarget,
  exec: (text: string, values: unknown[]) => Promise<unknown> = (text, values) =>
    runDatasetSql(text, values),
): Promise<void> {
  await exec(
    `delete from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid`,
    [target.nodeId, target.workspaceId],
  );
}

/**
 * Replace every row in one statement pair, inside a transaction: a replace
 * that deleted and then failed to insert would leave an empty dataset whose
 * node still claims a row count, and nothing would say which half happened.
 * Indexes restart at 0 — a replace is a new table, not an edit of the old one.
 */
export async function replaceAllRows(
  target: DatasetTarget,
  rows: readonly Record<string, CellValue>[],
): Promise<void> {
  requirePool();
  const { withTransaction } = await import("@/lib/queue/db");
  await withTransaction(async (tx) => {
    await deleteAllRows(target, (text, values) => tx.executeSql(text, values));
    await insertRows(target, 0, rows, (text, values) => tx.executeSql(text, values));
  });
}

/** The first `limit` rows in file order — what `op=sample` returns. */
export async function readSampleRows(
  target: DatasetTarget,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows = await runDatasetSql<{ data: Record<string, unknown> }>(
    `select data from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid` +
      ` order by idx asc limit $3`,
    [target.nodeId, target.workspaceId, limit],
  );
  return rows.map((row) => row.data ?? {});
}

/* -- keyed rows (0103) -------------------------------------------------------- */

/**
 * Upsert rows by their stable key: a key that exists has its row MERGED with
 * the new values (`data || new`), a new key is appended after the highest
 * index. Positional rows (key null) are never touched.
 *
 * One transaction under an advisory lock on the dataset: two writers
 * appending at once would otherwise both read the same max(idx) and collide
 * on the primary key, and the second write would fail for a reason its caller
 * cannot act on. The lock is per dataset, so unrelated datasets never wait.
 */
export async function upsertKeyedRows(
  target: DatasetTarget,
  rows: ReadonlyArray<{ key: string; data: Record<string, CellValue> }>,
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  requirePool();
  const { withTransaction } = await import("@/lib/queue/db");
  return withTransaction(async (tx) => {
    const exec = (text: string, values: unknown[]) => tx.executeSql(text, values);
    await exec(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [target.nodeId]);
    const keys = rows.map((row) => row.key);
    const found = await exec(
      `select key from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid and key = any($3::text[])`,
      [target.nodeId, target.workspaceId, keys],
    );
    const existing = new Set((found.rows as Array<{ key: string }>).map((row) => row.key));
    const updates = rows.filter((row) => existing.has(row.key));
    const inserts = rows.filter((row) => !existing.has(row.key));
    if (updates.length > 0) {
      await exec(
        `update ${DATASET_ROWS_TABLE} as d set data = d.data || t.data` +
          ` from jsonb_to_recordset($3::jsonb) as t(key text, data jsonb)` +
          ` where d.node_id = $1::uuid and d.workspace_id = $2::uuid and d.key = t.key`,
        [target.nodeId, target.workspaceId, JSON.stringify(updates)],
      );
    }
    if (inserts.length > 0) {
      const max = await exec(
        `select coalesce(max(idx), -1) as max_idx from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid`,
        [target.nodeId, target.workspaceId],
      );
      const start = Number((max.rows[0] as { max_idx: number } | undefined)?.max_idx ?? -1) + 1;
      const last = start + inserts.length - 1;
      if (last >= DATASET_MAX_ROWS) {
        throw new DatasetError(
          "too_many_rows",
          `this write would reach row index ${last}; a dataset holds at most ${DATASET_MAX_ROWS} rows.`,
        );
      }
      await exec(
        `insert into ${DATASET_ROWS_TABLE} (node_id, workspace_id, idx, key, data)` +
          ` select $1::uuid, $2::uuid, t.idx, t.key, t.data` +
          ` from jsonb_to_recordset($3::jsonb) as t(idx int, key text, data jsonb)`,
        [target.nodeId, target.workspaceId, JSON.stringify(inserts.map((row, offset) => ({ idx: start + offset, key: row.key, data: row.data })))],
      );
    }
    return { inserted: inserts.length, updated: updates.length };
  });
}

/** One keyed row, or null. */
export async function readRowByKey(target: DatasetTarget, key: string): Promise<Record<string, unknown> | null> {
  const rows = await runDatasetSql<{ data: Record<string, unknown> }>(
    `select data from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid and key = $3`,
    [target.nodeId, target.workspaceId, key],
  );
  return rows[0]?.data ?? null;
}

/** Delete one keyed row; true when there was one. */
export async function deleteRowByKey(target: DatasetTarget, key: string): Promise<boolean> {
  const rows = await runDatasetSql<{ idx: number }>(
    `delete from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid and key = $3 returning idx`,
    [target.nodeId, target.workspaceId, key],
  );
  return rows.length > 0;
}
