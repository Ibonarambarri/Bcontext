"use client";

/**
 * The workspace's record types — `account`, `deal`, `supplier`… — and their
 * fields. Rendered by `workspace-admin-modal.tsx`; reads and writes
 * `/api/workspaces/<slug>/record-types` through `@/lib/business/client`.
 *
 * Agents fill records in; this is where a person shapes what a record is:
 * the fields (key, label, type, required, options, relation target and a
 * one-line description — the line an agent reads to decide what goes
 * there, and for a number or money field what its table footer totals
 * to), which select field is the pipeline stage, and, once, where the
 * records are stored. The draft and its validation are
 * `@/lib/business/record-type-draft`, so what is sent is what the
 * contract's schemas accept and their errors are shown before saving.
 *
 * Must not break: storage is chosen at creation and then read-only, with
 * the reason on screen — the database refuses the change too (0103), and a
 * form that offered it would only fail later. An existing field's key is
 * read-only for the same reason. A non-manager sees the list, not the editor.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Skeleton,
  TextField,
} from "@heroui/react";
import { NODE_KINDS } from "@bcontext-dev/contract/types";
import type { RecordFieldType, RecordStorage, RecordType } from "@bcontext-dev/contract/business/record-types";
import {
  createRecordType,
  deleteRecordType,
  fetchRecordTypes,
  updateRecordType,
} from "@/lib/business/client";
import {
  FIELD_TYPES,
  FIELD_TOTAL_LABELS,
  FIELD_TYPE_LABELS,
  draftFromType,
  emptyField,
  emptyType,
  inputFromDraft,
  labelFromKey,
  patchFromDraft,
  type FieldDraft,
  type TypeDraft,
} from "@/lib/business/record-type-draft";
import { Block, SectionHead } from "./panel-ui";

const HINT = "What your records are made of. Agents and your app fill them in; the fields' descriptions are what an agent reads to decide what goes where.";

export function RecordTypesSection({ slug, canManage }: { slug: string; canManage: boolean }) {
  const [types, setTypes] = useState<RecordType[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypeDraft | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setTypes(await fetchRecordTypes(slug));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the record types.");
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (draft) {
    return (
      <TypeEditor
        slug={slug}
        initial={draft}
        types={types ?? []}
        onDone={async () => {
          setDraft(null);
          await load();
        }}
        onCancel={() => setDraft(null)}
      />
    );
  }

  return (
    <div>
      <SectionHead
        title="Record types"
        hint={HINT}
        action={canManage ? (
          <Button size="sm" variant="secondary" onPress={() => setDraft(emptyType())}>
            <Plus size={13} /> New type
          </Button>
        ) : undefined}
      />
      {loadError ? (
        <p role="alert" className="text-[13px] text-danger">{loadError}</p>
      ) : !types ? (
        <div role="status" aria-label="Loading the record types" className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[64px] rounded-[10px]" />)}
        </div>
      ) : types.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted">
          No record types yet. Applying a business template adds the usual ones; or create your own.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {types.map((type) => (
            <li key={type.id}>
              <button
                type="button"
                disabled={!canManage}
                onClick={() => setDraft(draftFromType(type))}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors enabled:hover:bg-default/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-foreground">{type.label}</span>
                    <code className="text-[11.5px] text-muted">{type.key}</code>
                    {type.storage === "dataset" ? (
                      <Chip size="sm" variant="secondary"><Chip.Label>dataset</Chip.Label></Chip>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted">
                    {type.fields.length === 0
                      ? "No fields"
                      : type.fields.map((field) => field.label).join(" · ")}
                    {type.stage_field ? ` — stages: ${(type.fields.find((f) => f.key === type.stage_field)?.options ?? []).join(" → ")}` : ""}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TypeEditor({
  slug,
  initial,
  types,
  onDone,
  onCancel,
}: {
  slug: string;
  initial: TypeDraft;
  types: RecordType[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TypeDraft>(initial);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const set = <K extends keyof TypeDraft>(key: K, value: TypeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setField = (index: number, next: Partial<FieldDraft>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...next } : f)) }));

  const targets = useMemo(
    () => [...types.filter((t) => t.storage === "node").map((t) => ({ key: t.key, label: t.label })), ...NODE_KINDS.map((k) => ({ key: k as string, label: k as string }))],
    [types],
  );
  const selectFields = draft.fields.filter((f) => f.type === "select" && f.key);

  async function save() {
    setErrors([]);
    const result = draft.isNew ? inputFromDraft(draft) : patchFromDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setPending(true);
    try {
      if (draft.isNew) await createRecordType(slug, result.value as Parameters<typeof createRecordType>[1]);
      else await updateRecordType(slug, draft.key, result.value as Parameters<typeof updateRecordType>[2]);
      await onDone();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Couldn't save."]);
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setErrors([]);
    try {
      await deleteRecordType(slug, draft.key);
      await onDone();
    } catch (err) {
      // The API refuses while records of this type exist, and says so.
      setErrors([err instanceof Error ? err.message : "Couldn't delete."]);
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={onCancel} className="mb-3 flex items-center gap-1 text-[12.5px] text-muted hover:text-foreground">
        <ChevronLeft size={13} /> Record types
      </button>
      <SectionHead
        title={draft.isNew ? "New record type" : draft.label || draft.key}
        hint={draft.isNew ? "Name it, choose where its records live, then add its fields." : draft.storage === "dataset" ? "Records of this type are rows of a dataset." : `Records of this type are nodes of kind ${draft.key}.`}
      />

      <Block title="Identity">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            value={draft.key}
            onChange={(v) => setDraft((d) => ({ ...d, key: v.toLowerCase(), label: d.label || labelFromKey(v.toLowerCase()) }))}
            isDisabled={!draft.isNew || pending}
          >
            <Label>Key</Label>
            <Input placeholder="account" />
            <Description>{draft.isNew ? "Lowercase, digits and _. It becomes the node kind agents write." : "Fixed: it is the kind every record carries."}</Description>
          </TextField>
          <TextField value={draft.label} onChange={(v) => set("label", v)} isDisabled={pending}>
            <Label>Label</Label>
            <Input placeholder="Account" />
          </TextField>
          <TextField value={draft.labelPlural} onChange={(v) => set("labelPlural", v)} isDisabled={pending}>
            <Label>Plural</Label>
            <Input placeholder="Accounts" />
          </TextField>
          <TextField value={draft.description} onChange={(v) => set("description", v)} isDisabled={pending}>
            <Label>Description</Label>
            <Input placeholder="A company that pays us" />
          </TextField>
        </div>
      </Block>

      <Block
        title="Storage"
        hint="Where the records live. Chosen once: it cannot be changed after the type is created, because moving records between the two would change every id that points at them."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["node", "dataset"] as RecordStorage[]).map((storage) => (
            <button
              key={storage}
              type="button"
              aria-pressed={draft.storage === storage}
              disabled={!draft.isNew || pending}
              onClick={() => set("storage", storage)}
              className={`rounded-[10px] border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed ${draft.storage === storage ? "border-[var(--ink)] shadow-[inset_0_0_0_1px_var(--ink)]" : "border-border opacity-80 enabled:hover:border-[var(--ink-3)]"}`}
            >
              <span className="block text-[13px] font-medium text-foreground">{storage === "node" ? "Nodes" : "Dataset rows"}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.45] text-muted">
                {storage === "node"
                  ? "Each record is a node: it has a page, links, decisions and a 360 view. For accounts, deals, suppliers — tens to thousands."
                  : "Each record is a row of one dataset node. For many, personal records (B2C customers) that should not be pages."}
              </span>
            </button>
          ))}
        </div>
        {draft.storage === "dataset" ? (
          <TextField value={draft.datasetNodeId} onChange={(v) => set("datasetNodeId", v)} isDisabled={!draft.isNew || pending} className="mt-3 max-w-md">
            <Label>Dataset node id</Label>
            <Input placeholder="the id of a data node" />
            <Description>The data node whose rows hold the records (its id is in its page address).</Description>
          </TextField>
        ) : null}
      </Block>

      <Block
        title="Fields"
        action={
          <Button size="sm" variant="ghost" isDisabled={pending} onPress={() => set("fields", [...draft.fields, emptyField()])}>
            <Plus size={13} /> Add field
          </Button>
        }
      >
        {draft.fields.length === 0 ? (
          <p className="text-[12.5px] text-muted">No fields yet.</p>
        ) : (
          <div className="space-y-3">
            {draft.fields.map((field, index) => (
              <FieldRow
                key={index}
                field={field}
                targets={targets}
                disabled={pending}
                onChange={(next) => setField(index, next)}
                onRemove={() => set("fields", draft.fields.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}
      </Block>

      <Block title="Stage" hint="A select field whose options are the stages, in order. Boards group by it; it is not the node's status.">
        <Select
          aria-label="Stage field"
          className="max-w-xs"
          value={draft.stageField || "__none"}
          onChange={(key) => set("stageField", key === "__none" ? "" : String(key))}
          isDisabled={pending}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="__none" textValue="No stage">No stage</ListBox.Item>
              {selectFields.map((f) => (
                <ListBox.Item key={f.key} id={f.key} textValue={f.label || f.key}>{f.label || f.key}</ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </Block>

      {errors.length ? (
        <Alert role="alert" status="danger" className="mb-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onPress={() => void save()} isPending={pending} isDisabled={pending}>
          {draft.isNew ? "Create type" : "Save changes"}
        </Button>
        <Button variant="ghost" onPress={onCancel} isDisabled={pending}>Cancel</Button>
        {!draft.isNew ? (
          <Button variant="ghost" className="ml-auto text-danger" onPress={() => void remove()} isDisabled={pending}>
            <Trash2 size={13} /> Delete type
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  targets,
  disabled,
  onChange,
  onRemove,
}: {
  field: FieldDraft;
  targets: { key: string; label: string }[];
  disabled: boolean;
  onChange: (next: Partial<FieldDraft>) => void;
  onRemove: () => void;
}) {
  const choice = field.type === "select" || field.type === "multi_select";
  const numeric = field.type === "number" || field.type === "money";
  return (
    <div className="rounded-[10px] border border-border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_160px_auto]">
        <TextField
          aria-label="Field key"
          value={field.key}
          onChange={(v) => onChange({ key: v.toLowerCase(), ...(field.label ? {} : { label: labelFromKey(v.toLowerCase()) }) })}
          isDisabled={disabled || !field.isNew}
        >
          <Input placeholder="key" className="font-mono text-[12.5px]" />
        </TextField>
        <TextField aria-label="Field label" value={field.label} onChange={(v) => onChange({ label: v })} isDisabled={disabled}>
          <Input placeholder="Label" />
        </TextField>
        <Select
          aria-label="Field type"
          value={field.type}
          onChange={(key) => onChange({ type: String(key) as RecordFieldType })}
          isDisabled={disabled || !field.isNew}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {FIELD_TYPES.map((type) => (
                <ListBox.Item key={type} id={type} textValue={FIELD_TYPE_LABELS[type]}>{FIELD_TYPE_LABELS[type]}</ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Button isIconOnly size="sm" variant="ghost" aria-label="Remove field" onPress={onRemove} isDisabled={disabled}>
          <Trash2 size={13} />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {choice ? (
          <TextField aria-label="Options" value={field.optionsText} onChange={(v) => onChange({ optionsText: v })} isDisabled={disabled}>
            <Input placeholder="Options, comma-separated: lead, trial, won" />
          </TextField>
        ) : null}
        {field.type === "relation" ? (
          <div className="flex items-center gap-3">
            <Select
              aria-label="Relation target"
              className="min-w-0 flex-1"
              value={field.target || null}
              onChange={(key) => onChange({ target: String(key) })}
              isDisabled={disabled}
              placeholder="Points at…"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {targets.map((t) => <ListBox.Item key={t.key} id={t.key} textValue={t.label}>{t.label}</ListBox.Item>)}
                </ListBox>
              </Select.Popover>
            </Select>
            <Checkbox isSelected={field.multiple} onChange={(v) => onChange({ multiple: v })} isDisabled={disabled}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content><Label className="text-[12.5px]">Many</Label></Checkbox.Content>
            </Checkbox>
          </div>
        ) : null}
        {numeric ? (
          <Select
            aria-label="Column total"
            value={field.total || "auto"}
            onChange={(key) => onChange({ total: key === "auto" ? "" : (String(key) as FieldDraft["total"]) })}
            isDisabled={disabled}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(Object.keys(FIELD_TOTAL_LABELS) as Array<keyof typeof FIELD_TOTAL_LABELS>).map((mode) => (
                  <ListBox.Item key={mode || "auto"} id={mode || "auto"} textValue={FIELD_TOTAL_LABELS[mode]}>{FIELD_TOTAL_LABELS[mode]}</ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        ) : null}
        <TextField aria-label="Field description" value={field.description} onChange={(v) => onChange({ description: v })} isDisabled={disabled} className={choice || numeric || field.type === "relation" ? "" : "sm:col-span-2"}>
          <Input placeholder="One line for the agent: what goes here" />
        </TextField>
      </div>
      <Checkbox className="mt-2" isSelected={field.required} onChange={(v) => onChange({ required: v })} isDisabled={disabled}>
        <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
        <Checkbox.Content><Label className="text-[12.5px]">Required</Label></Checkbox.Content>
      </Checkbox>
    </div>
  );
}
