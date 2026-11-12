"use client";

/**
 * A board over record types — the Pipeline (deals by stage), Requests (by
 * status, heaviest first), Incidents. Chosen by `business-view.tsx` when a
 * `board` view's group-by is a record field (`field:<key>`, or the type's
 * `stage_field` by default).
 *
 * Columns are the field's select options in order; each header reads
 * "Proposal · 3 · €2,100/mo" (`columnSummary`: count plus the sum of the
 * layout's `board.total_field`, else the first money/number field). Dragging
 * a card to another column is the one edit this surface makes: it sends
 * `PATCH /api/nodes/:id { fields: { <field>: <column> } }` — the light edit
 * through the node update API, validated there against the record type.
 *
 * Optimistic: the card moves on drop and the totals follow; a refused patch
 * (400 names the field, 403, network) puts it back and toasts. The task
 * board (`board-renderer.tsx`) is untouched — it groups core columns of
 * tasks and bugs; this one groups fields of records.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordFieldDef } from "@bcontext-dev/contract/business/record-types";
import {
  NO_VALUE_COLUMN,
  boardValueOf,
  columnSummary,
  findFieldDef,
  groupRecordRows,
  headlineTotal,
  recordBoardColumns,
  recordMovePatch,
  sortRecordRows,
  totalsFor,
  type RecordRow,
} from "@bcontext-dev/contract/views/fields";
import type { RecordViewPayload } from "@bcontext-dev/contract/views/business";
import { parseFieldRef, type ViewPresentation } from "@bcontext-dev/contract/views/schema";
import { Kanban, useKanban, useKanbanColumn } from "@/components/ui/kanban";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { patchRecordFields } from "@/lib/business/requests";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { FieldValue } from "./field-value";

type Card = RecordRow & { column: string };

export function RecordBoard({
  workspace,
  payload,
  field,
  presentation,
}: {
  workspace: WorkspaceAddress;
  payload: RecordViewPayload;
  field: RecordFieldDef;
  presentation: ViewPresentation;
}) {
  const toast = useToast();
  const { selectNode } = useWorkspace();
  const [rows, setRows] = useState(payload.rows);
  const board = (presentation.layout.board ?? {}) as { total_field?: string; total_suffix?: string };
  const columns = useMemo(() => recordBoardColumns(field, rows), [field, rows]);
  const sorted = useMemo(() => sortRecordRows(rows, presentation.sort_by, payload.types), [rows, presentation.sort_by, payload.types]);
  const allFields = useMemo(() => payload.types.flatMap((type) => type.fields), [payload.types]);
  const cardFields = useMemo(() => cardFieldDefs(presentation, payload.types, field), [presentation, payload.types, field]);

  // The kanban list holds the cards; a cross-column drop calls `setColumn`
  // exactly once, which is where the edit is sent from.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  // Set once the kanban exists; a failed edit reads it to put the card back.
  const kanbanRef = useRef<{ moveItem: (key: string, column: string) => void } | null>(null);
  const move = useCallback((card: Card, column: string) => {
    const current = rowsRef.current.find((row) => row.id === card.id);
    if (!current) return;
    const patch = recordMovePatch(field, current, column);
    if (!patch) return;
    const before = current.fields;
    rowsRef.current = rowsRef.current.map((row) => (row.id === card.id ? { ...row, fields: { ...row.fields, ...patch } } : row));
    setRows(rowsRef.current);
    void patchRecordFields(workspace, card.id, patch).then((outcome) => {
      if (outcome.status === "ok") return;
      setRows((list) => list.map((row) => (row.id === card.id ? { ...row, fields: before } : row)));
      kanbanRef.current?.moveItem(card.id, boardValueOf({ ...card, fields: before }, field));
      toast.error(outcome.status === "invalid" ? outcome.message : outcome.status === "forbidden" ? "You cannot edit this record." : "The move could not be saved.");
    });
  }, [field, toast, workspace]);

  const kanban = useKanban<Card>({
    initialItems: sorted.map((row) => ({ ...row, column: boardValueOf(row, field) })),
    getKey: (card) => card.id,
    getColumn: (card) => card.column,
    setColumn: (card, column) => {
      if (card.column !== column) move(card, column);
      return { ...card, column };
    },
    dragType: `record-card-${field.key}`,
  });
  useEffect(() => {
    kanbanRef.current = kanban;
  });

  const groups = useMemo(() => groupRecordRows(field, rows, columns), [field, rows, columns]);

  return (
    <Kanban className="pb-4">
      {columns.map((column) => {
        const members = groups.get(column.value) ?? [];
        const totals = totalsFor(allFields, members);
        const headline = headlineTotal(totals, board.total_field);
        return (
          <RecordColumn
            key={column.value}
            kanban={kanban}
            value={column.value}
            title={column.value === NO_VALUE_COLUMN ? column.label : column.label.replace(/_/g, " ")}
            summary={columnSummary("", totals, headline, board.total_suffix ?? "").replace(/^ · /, "")}
            cardFields={cardFields}
            onOpen={selectNode}
          />
        );
      })}
    </Kanban>
  );
}

function RecordColumn({
  kanban,
  value,
  title,
  summary,
  cardFields,
  onOpen,
}: {
  kanban: ReturnType<typeof useKanban<Card>>;
  value: string;
  title: string;
  summary: string;
  cardFields: RecordFieldDef[];
  onOpen: (id: string) => void;
}) {
  const { items, dragAndDropHooks } = useKanbanColumn(kanban, value);
  return (
    <Kanban.Column aria-label={title}>
      <Kanban.ColumnHeader>
        <Kanban.ColumnTitle className="capitalize">{title}</Kanban.ColumnTitle>
        <Kanban.ColumnCount className="tabular-nums">{summary}</Kanban.ColumnCount>
      </Kanban.ColumnHeader>
      <Kanban.ColumnBody>
        <Kanban.CardList
          aria-label={`${title} records`}
          items={items}
          dragAndDropHooks={dragAndDropHooks}
          onAction={(key) => onOpen(String(key))}
          renderEmptyState={() => <span className="text-[11.5px] text-[var(--ink-mute)]">Nothing here</span>}
        >
          {(card) => (
            <Kanban.Card id={card.id} textValue={card.title}>
              <span className="text-[13px] font-medium leading-snug text-[var(--ink)]">{card.title}</span>
              {cardFields.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
                  {cardFields.map((def) => (
                    <div key={def.key} className="contents">
                      <dt className="text-[var(--ink-mute)]">{def.label}</dt>
                      <dd className="m-0 min-w-0 truncate text-[var(--ink-2)]"><FieldValue field={def} value={card.fields[def.key]} /></dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </Kanban.Card>
          )}
        </Kanban.CardList>
      </Kanban.ColumnBody>
    </Kanban.Column>
  );
}

/** The fields a card lists: the view's `field:` columns minus the grouping one (the column already says it). */
function cardFieldDefs(presentation: ViewPresentation, types: RecordViewPayload["types"], group: RecordFieldDef): RecordFieldDef[] {
  return presentation.columns
    .map((column) => parseFieldRef(column))
    .filter((key): key is string => Boolean(key) && key !== group.key)
    .map((key) => findFieldDef(types, key))
    .filter((def): def is RecordFieldDef => Boolean(def))
    .slice(0, 4);
}
