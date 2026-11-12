"use client";

/**
 * One record field, displayed: money with its currency (and a number field
 * marked `unit: "money"` in the reporting currency), dates as dates,
 * selects as chips, relations as links that open the node in the floating
 * panel, urls/emails as links. The text comes from the contract's
 * `displayFieldValue`, so a table cell, a board card and an agent's reading
 * agree on what "€2,100" is.
 *
 * Used by the record board, the record and dataset tables. Relation ids are
 * labelled with the node's title when the workspace context has it; an id the
 * caller cannot see stays a short id rather than disappearing.
 */
import type { RecordFieldDef, RecordFieldValue } from "@bcontext-dev/contract/business/record-types";
import { displayFieldValue } from "@bcontext-dev/contract/views/fields";
import { cn } from "@bcontext-dev/contract/utils";
import { useWorkspace } from "@/components/workspace-context";
import { workspacePath } from "@/web/workspace-url";
import { NodeLink } from "@/components/node-open-link";
import { useBusiness } from "./business-context";

export function FieldValue({ field, value, className }: { field: Pick<RecordFieldDef, "type" | "unit">; value: RecordFieldValue | undefined; className?: string }) {
  // A number field with `unit: "money"` is in the reporting currency.
  const display = displayFieldValue(field, value, { currency: useBusiness().currency });
  switch (display.kind) {
    case "empty":
      return <span className={cn("text-[var(--ink-mute)]", className)}>—</span>;
    case "chips":
      return (
        <span className={cn("inline-flex flex-wrap gap-1", className)}>
          {display.values.map((chip) => (
            <span key={chip} className="rounded-full border border-[var(--line)] bg-[var(--paper-2)] px-1.5 py-px text-[11px] leading-4 text-[var(--ink-2)]">
              {chip.replace(/_/g, " ")}
            </span>
          ))}
        </span>
      );
    case "relation":
      return <RelationLinks ids={display.ids} className={className} />;
    case "link":
      return (
        <a href={display.href} target={display.href.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer" className={cn("truncate text-[var(--accent)] hover:underline", className)}>
          {display.text}
        </a>
      );
    default:
      return <span className={cn("tabular-nums", className)}>{display.text}</span>;
  }
}

function RelationLinks({ ids, className }: { ids: string[]; className?: string }) {
  const { nodes, address } = useWorkspace();
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap gap-x-1.5", className)}>
      {ids.map((id, index) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return (
          <span key={id} className="min-w-0 truncate">
            <NodeLink nodeId={id} href={workspacePath(address, `n/${id}`)} className="text-[var(--ink)] underline decoration-[var(--line-strong)] underline-offset-2 hover:decoration-[var(--ink)]">
              {node?.title ?? id.slice(0, 8)}
            </NodeLink>
            {index < ids.length - 1 ? "," : null}
          </span>
        );
      })}
    </span>
  );
}
