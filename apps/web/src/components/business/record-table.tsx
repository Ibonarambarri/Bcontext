"use client";

/**
 * A table over records — node records (Accounts, Renewals) or the keyed rows
 * of a dataset-backed type (Customers, Suppliers). Chosen by
 * `business-view.tsx` for `table`/`list` views whose query names record
 * kinds or a `dataset_type`.
 *
 * Columns are the view's (`title`, `field:<key>`…; every field when it names
 * none), formatted by `FieldValue`. The footer sums every number and money
 * column (and counts the values present), so "how much MRR renews this
 * quarter" is read, not computed. Read-only: a node row opens in the floating
 * panel; a dataset row offers "Convert to node" — the API's promote op, which
 * makes the row a node record (an account, a VIP customer) and opens it. The
 * action is hidden when no node record type exists to promote into, or once
 * the API answers that it has no promote route.
 */
import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@heroui/react";
import {
  formatMoney,
  formatNumber,
  recordTableColumns,
  sortRecordRows,
  totalsFor,
  type RecordColumn,
  type RecordRow,
} from "@bcontext-dev/contract/views/fields";
import type { DatasetViewPayload, RecordViewPayload } from "@bcontext-dev/contract/views/business";
import type { ViewPresentation } from "@bcontext-dev/contract/views/schema";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { promoteRow } from "@/lib/business/requests";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { FieldValue } from "./field-value";

type Source =
  | { kind: "records"; payload: RecordViewPayload }
  | { kind: "dataset"; payload: DatasetViewPayload };

export function RecordTable({ workspace, source, presentation }: { workspace: WorkspaceAddress; source: Source; presentation: ViewPresentation }) {
  const { selectNode } = useWorkspace();
  const toast = useToast();
  const types = useMemo(() => (source.kind === "records" ? source.payload.types : [source.payload.type]), [source]);
  const columns = useMemo(() => {
    const resolved = recordTableColumns(types, presentation);
    // A dataset row has no title column of its own: its key stands in.
    return source.kind === "dataset" ? resolved.filter((column) => !("core" in column) || column.core !== "title") : resolved;
  }, [types, presentation, source.kind]);
  const rows = useMemo(() => sortRecordRows(source.payload.rows, presentation.sort_by, types), [source.payload.rows, presentation.sort_by, types]);
  const fieldDefs = columns.flatMap((column) => ("field" in column ? [column.field] : []));
  const totals = useMemo(() => totalsFor(fieldDefs, rows), [fieldDefs, rows]);
  const [promoteHidden, setPromoteHidden] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const promoteTarget = source.kind === "dataset" ? source.payload.promote_targets[0] ?? null : null;
  const canPromote = source.kind === "dataset" && Boolean(promoteTarget) && !promoteHidden && Boolean(source.payload.type.dataset_node_id);

  async function convert(row: RecordRow) {
    if (source.kind !== "dataset" || !promoteTarget || !source.payload.type.dataset_node_id) return;
    setBusyKey(row.id);
    const outcome = await promoteRow(workspace, source.payload.type.dataset_node_id, row.id, promoteTarget.key);
    setBusyKey(null);
    if (outcome.status === "unavailable") {
      setPromoteHidden(true);
      return;
    }
    if (outcome.status === "failed") {
      toast.error(outcome.message);
      return;
    }
    toast.info(outcome.created ? `Converted to a ${promoteTarget.label.toLowerCase()}.` : `Updated the existing ${promoteTarget.label.toLowerCase()}.`);
    selectNode(outcome.node_id);
  }

  if (rows.length === 0) {
    return <p className="py-16 text-center text-[12px] text-[var(--ink-3)]">No records match this view yet.</p>;
  }

  return (
    <div className="scroll overflow-x-auto rounded-[var(--radius)] border border-[var(--line)]">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-[1] bg-[var(--paper-2)]">
          <tr>
            {source.kind === "dataset" ? <Th>Key</Th> : null}
            {columns.map((column) => <Th key={columnId(column)} align={alignOf(column)}>{columnLabel(column)}</Th>)}
            {canPromote ? <Th><span className="sr-only">Actions</span></Th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-[var(--line)] hover:bg-[var(--paper-2)]">
              {source.kind === "dataset" ? <td className="px-3 py-1.5 font-mono text-[11px] text-[var(--ink-3)]">{row.id}</td> : null}
              {columns.map((column) => (
                <td key={columnId(column)} className={`max-w-[280px] truncate px-3 py-1.5 ${alignOf(column) === "end" ? "text-right" : ""}`}>
                  {"field" in column ? (
                    <FieldValue field={column.field} value={row.fields[column.field.key]} />
                  ) : column.core === "title" ? (
                    <button type="button" onClick={() => selectNode(row.id)} className="max-w-full truncate text-left font-medium text-[var(--ink)] hover:underline">
                      {row.title}
                    </button>
                  ) : (
                    <span className="text-[var(--ink-mute)]">—</span>
                  )}
                </td>
              ))}
              {canPromote ? (
                <td className="px-2 py-1 text-right">
                  <Button size="sm" variant="ghost" isDisabled={busyKey === row.id} onPress={() => void convert(row)} className="gap-1 text-[11px] text-[var(--ink-2)]">
                    <ArrowUpRight size={12} />
                    Convert to {promoteTarget!.label.toLowerCase()}
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-[var(--line-strong)] bg-[var(--paper-2)] text-[11.5px] text-[var(--ink-3)]">
          <tr>
            {source.kind === "dataset" ? <td className="px-3 py-1.5">{countText(totals.count)}</td> : null}
            {columns.map((column, index) => {
              const total = "field" in column ? totals.totals.find((t) => t.field === column.field.key) : undefined;
              return (
                <td key={columnId(column)} className={`px-3 py-1.5 tabular-nums ${alignOf(column) === "end" ? "text-right" : ""}`}>
                  {index === 0 && source.kind === "records" && !total ? countText(totals.count) : total ? totalText(total) : null}
                </td>
              );
            })}
            {canPromote ? <td /> : null}
          </tr>
        </tfoot>
      </table>
      {source.kind === "dataset" && source.payload.truncated ? (
        <p className="border-t border-[var(--line)] px-3 py-1.5 text-[11px] text-[var(--ink-3)]">
          Showing {rows.length} of {source.payload.total} rows. Ask an agent to query the dataset for the rest.
        </p>
      ) : null}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "start" | "end" }) {
  return <th className={`whitespace-nowrap px-3 py-1.5 text-[11px] font-medium text-[var(--ink-3)] ${align === "end" ? "text-right" : "text-left"}`}>{children}</th>;
}

function columnId(column: RecordColumn): string {
  return "field" in column ? `field:${column.field.key}` : column.core;
}

function columnLabel(column: RecordColumn): string {
  if ("field" in column) return column.field.label;
  return column.core === "title" ? "Name" : column.core.replace(/_/g, " ");
}

function alignOf(column: RecordColumn): "start" | "end" {
  return "field" in column && (column.field.type === "money" || column.field.type === "number") ? "end" : "start";
}

function countText(count: number): string {
  return `${count} ${count === 1 ? "record" : "records"}`;
}

function totalText(total: ReturnType<typeof totalsFor>["totals"][number]): string {
  if (total.mixed_currency) return "mixed currencies";
  if (total.sum === null) return "";
  return `Σ ${total.type === "money" ? formatMoney(total.sum, total.currency ?? "EUR") : formatNumber(total.sum)}`;
}

