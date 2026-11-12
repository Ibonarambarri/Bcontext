"use client";

/**
 * A record's fields as a read-first header on its node page: label and value
 * in a quiet grid, the stage first. Agents write records; this is for
 * reading them fast, so a value is text until somebody clicks it — then that
 * one field becomes an input, saved on Enter or blur, cancelled on Escape.
 * No form, no save button.
 *
 * Who uses it: `app/w/[ws]/n/[nodeId]/page.tsx` for a node whose kind is one
 * of the workspace's record types. Writes the guarded node PATCH through
 * `@/lib/business/client.patchRecordField` (the API validates the value
 * against the type and answers in words); a 409 or a refusal is shown
 * under the field, and the page is refreshed after a write.
 *
 * Must not break: relation and person fields are read-only here (choosing a
 * node or a member is a picker, not a light edit), and multi-select is too.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, Input, ListBox, Select, Switch, TextField } from "@heroui/react";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { RecordFieldDef, RecordFieldValue, RecordType } from "@bcontext-dev/contract/business/record-types";
import { patchRecordField } from "@/lib/business/client";
import { useBusiness } from "./business-context";
import { fieldsOf, formatFieldValue, headerFields, isMoney } from "@/lib/business/records";
import type { WorkspaceAddress } from "@/web/workspace-url";

const EDITABLE = new Set<RecordFieldDef["type"]>(["text", "number", "money", "date", "boolean", "select", "url", "email"]);

export function RecordFieldsHeader({
  workspace,
  node,
  type,
  titles,
  canWrite,
}: {
  workspace: WorkspaceAddress;
  node: Pick<KnowledgeNode, "id" | "data" | "updated_at">;
  type: RecordType;
  /** id → title for relation values. */
  titles: Record<string, string>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(node);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const titleMap = new Map(Object.entries(titles));
  const { currency } = useBusiness();
  const fields = headerFields(type, fieldsOf(current));

  async function save(def: RecordFieldDef, value: RecordFieldValue) {
    setEditing(null);
    if (JSON.stringify(fieldsOf(current)[def.key] ?? null) === JSON.stringify(value)) return;
    setSaving(def.key);
    setError(null);
    try {
      const next = await patchRecordField(workspace, current, { [def.key]: value });
      setCurrent(next);
      router.refresh();
    } catch (err) {
      setError({ field: def.key, message: err instanceof Error ? err.message : "Couldn't save." });
    } finally {
      setSaving(null);
    }
  }

  if (fields.length === 0) return null;

  return (
    <dl className="mt-1 grid grid-cols-1 gap-x-8 gap-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${type.label} fields`}>
      {fields.map(({ def, value, isStage }) => {
        const editable = canWrite && EDITABLE.has(def.type);
        const text = formatFieldValue(def, value, { titles: titleMap, currency });
        return (
          <div key={def.key} className={`min-w-0 ${def.type === "text" && text.length > 80 ? "sm:col-span-2 lg:col-span-3" : ""}`} title={def.description}>
            <dt className="text-[11.5px] text-muted">
              {def.label}
              {def.required ? <span aria-hidden="true"> *</span> : null}
            </dt>
            <dd className="mt-0.5 min-h-[22px] text-[13.5px] text-foreground">
              {editing === def.key ? (
                <FieldEditor def={def} value={value} onSave={(v) => void save(def, v)} onCancel={() => setEditing(null)} />
              ) : editable ? (
                <button
                  type="button"
                  onClick={() => setEditing(def.key)}
                  disabled={saving === def.key}
                  className="-mx-1 max-w-full rounded px-1 text-left hover:bg-default/40 disabled:opacity-60"
                  aria-label={`Edit ${def.label}`}
                >
                  <FieldText isStage={isStage} text={text} />
                </button>
              ) : (
                <FieldText isStage={isStage} text={text} />
              )}
              {error?.field === def.key ? <p role="alert" className="mt-1 text-[12px] text-danger">{error.message}</p> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function FieldText({ isStage, text }: { isStage: boolean; text: string }) {
  if (isStage && text !== "—") {
    return (
      <Chip size="sm" variant="soft" color="accent">
        <Chip.Label className="capitalize">{text.replace(/_/g, " ")}</Chip.Label>
      </Chip>
    );
  }
  return <span className={`break-words ${text === "—" ? "text-muted" : ""}`}>{text}</span>;
}

/** One field's input. Enter or blur saves; Escape cancels. */
function FieldEditor({
  def,
  value,
  onSave,
  onCancel,
}: {
  def: RecordFieldDef;
  value: RecordFieldValue | undefined;
  onSave: (value: RecordFieldValue) => void;
  onCancel: () => void;
}) {
  const initial = def.type === "money" ? (isMoney(value) ? String(value.amount) : "") : value === null || value === undefined ? "" : def.type === "date" ? String(value).slice(0, 10) : String(value);
  const [draft, setDraft] = useState(initial);
  const reporting = useBusiness().currency;

  if (def.type === "boolean") {
    return (
      <Switch isSelected={value === true} onChange={(next) => onSave(next)} autoFocus aria-label={def.label}>
        <Switch.Control><Switch.Thumb /></Switch.Control>
      </Switch>
    );
  }

  if (def.type === "select") {
    return (
      <Select
        aria-label={def.label}
        value={typeof value === "string" ? value : null}
        onChange={(key) => (key == null ? onCancel() : onSave(String(key)))}
        defaultOpen
        onOpenChange={(open) => { if (!open) onCancel(); }}
        className="max-w-[220px]"
      >
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover>
          <ListBox>
            {(def.options ?? []).map((option) => (
              <ListBox.Item key={option} id={option} textValue={option}>{option}</ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    );
  }

  const commit = () => {
    const raw = draft.trim();
    if (raw === "") return onSave(null);
    if (def.type === "number") return Number.isFinite(Number(raw)) ? onSave(Number(raw)) : onCancel();
    if (def.type === "money") {
      const currency = isMoney(value) ? value.currency : reporting;
      return Number.isFinite(Number(raw)) ? onSave({ amount: Number(raw), currency }) : onCancel();
    }
    return onSave(raw);
  };

  return (
    <TextField aria-label={def.label} value={draft} onChange={setDraft} autoFocus className="max-w-[320px]">
      <Input
        type={def.type === "date" ? "date" : def.type === "number" || def.type === "money" ? "number" : "text"}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
      />
    </TextField>
  );
}
