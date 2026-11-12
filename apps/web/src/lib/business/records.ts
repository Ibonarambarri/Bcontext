/**
 * Reading records: which record type a node is, how its field values print,
 * which other records hang off it, and an account's MRR history rebuilt from
 * its subscription events.
 *
 * Who uses it: the record header and the 360 layout on the node page
 * (`components/business/record-*.tsx`) and the overview's action lists
 * (`./overview.ts`). Pure — no fetch, no React — so the server render and
 * the tests agree.
 *
 * Nothing here knows a record type by name. A template calls its customers
 * `account`, another `client`; what makes a type a hub worth a 360 page is
 * that other types point at it through relation fields, and roles
 * (`findRole`) are guessed from keys and field shapes the same way. Must not
 * break: a record whose stored fields no longer match its definition (a
 * field removed, a value of the wrong type) still renders, as text.
 */
import {
  readRecordFields,
  type MoneyValue,
  type RecordFieldDef,
  type RecordFieldValue,
  type RecordFields,
  type RecordTypeDefinition,
} from "@bcontext-dev/contract/business/record-types";
import type { BusinessEvent } from "@bcontext-dev/contract/business/events";
import { formatCount, formatMoney } from "./format";

/** The bits of a node the record helpers read. Summaries and full nodes both fit. */
export interface RecordNodeLike {
  id: string;
  kind: string;
  title: string;
  status?: string | null;
  data?: Record<string, unknown> | null;
  updated_at?: string;
}

export function recordTypeFor<T extends Pick<RecordTypeDefinition, "key">>(kind: string, types: readonly T[]): T | null {
  return types.find((type) => type.key === kind) ?? null;
}

export function fieldsOf(node: Pick<RecordNodeLike, "data">): RecordFields {
  return readRecordFields(node.data ?? {});
}

/**
 * The app's id for a node record: `external_id` when it came from the ingest
 * API, else the row key it was promoted from (`source_row.key`) — the id its
 * events carry either way.
 */
export function externalIdOf(node: Pick<RecordNodeLike, "data">): string | null {
  const data = node.data as { external_id?: unknown; source_row?: { key?: unknown } } | null | undefined;
  const value = data?.external_id ?? data?.source_row?.key;
  return typeof value === "string" && value ? value : null;
}

export function isMoney(value: unknown): value is MoneyValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as MoneyValue).amount === "number" && typeof (value as MoneyValue).currency === "string";
}

/** A numeric reading of money or number values; null for anything else. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isMoney(value)) return value.amount;
  return null;
}

/** Ids a relation value points at, single or multiple. */
export function relationIds(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

/**
 * One value as text. `titles` resolves relation ids to the titles the page
 * already has; an id it cannot resolve prints shortened rather than not at all.
 */
export function formatFieldValue(
  field: Pick<RecordFieldDef, "type">,
  value: RecordFieldValue | unknown,
  opts: { titles?: ReadonlyMap<string, string>; people?: ReadonlyMap<string, string> } = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (field.type) {
    case "money":
      return isMoney(value) ? formatMoney(value.amount, value.currency) : String(value);
    case "number":
      return typeof value === "number" ? formatCount(value) : String(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "date":
      return typeof value === "string" ? formatDate(value) : String(value);
    case "multi_select":
      return Array.isArray(value) ? value.join(", ") || "—" : String(value);
    case "relation":
      return relationIds(value).map((id) => opts.titles?.get(id) ?? `#${id.slice(0, 8)}`).join(", ") || "—";
    case "person":
      return typeof value === "string" ? opts.people?.get(value) ?? `@${value.slice(0, 8)}` : String(value);
    default:
      if (Array.isArray(value)) return value.join(", ");
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
  }
}

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(time));
}

export interface HeaderField {
  def: RecordFieldDef;
  value: RecordFieldValue | undefined;
  isStage: boolean;
}

/**
 * The record header's fields in reading order: the stage first (it is what
 * the record is doing now), then the definition's order. Long text goes
 * last, where it can wrap. Values stored under keys the definition no longer
 * has are left out — the record header shows the type, not leftovers.
 */
export function headerFields(type: Pick<RecordTypeDefinition, "fields" | "stage_field">, fields: RecordFields): HeaderField[] {
  const out = type.fields.map((def) => ({ def, value: fields[def.key], isStage: def.key === type.stage_field }));
  const rank = (field: HeaderField) => (field.isStage ? 0 : field.def.type === "text" && typeof field.value === "string" && field.value.length > 80 ? 2 : 1);
  return out
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field);
}

/* -------------------------------------------------------------------------- */
/*  Relations                                                                 */
/* -------------------------------------------------------------------------- */

/** Relation fields of `type` that point at `targetKey`. */
export function relationFieldsTo(type: Pick<RecordTypeDefinition, "fields">, targetKey: string): RecordFieldDef[] {
  return type.fields.filter((field) => field.type === "relation" && field.target === targetKey);
}

/**
 * Is this type a hub — one other record types point at? Those are the
 * records worth a 360 page (an account, a supplier, a zone): their page is
 * mostly about what hangs off them.
 */
export function isHubType(typeKey: string, types: readonly Pick<RecordTypeDefinition, "key" | "fields">[]): boolean {
  return types.some((other) => other.key !== typeKey && relationFieldsTo(other, typeKey).length > 0);
}

export interface RelatedItem {
  id: string;
  kind: string;
  title: string;
  /** The field or link that relates it, for the row's hint. */
  via: string;
  stage?: string | null;
  status?: string | null;
}

export interface RelatedGroup {
  kind: string;
  label: string;
  items: RelatedItem[];
}

export interface RelatedInput {
  node: RecordNodeLike;
  type: RecordTypeDefinition | null;
  types: readonly RecordTypeDefinition[];
  /** Records of other types, with their fields (the 360 lists them per type). */
  records: readonly RecordNodeLike[];
  /** Mentions and edges, both directions — whatever the inspector reported. */
  links: readonly { id: string; kind: string | null; title: string | null; via: string }[];
  /** Titles and kinds of every node the page can see, to resolve this node's own relation ids. */
  index: ReadonlyMap<string, { kind: string; title: string; status?: string | null }>;
}

const CORE_LABELS: Record<string, string> = {
  task: "Tasks",
  bug: "Bugs",
  decision: "Decisions",
  adr: "ADRs",
  doc: "Docs",
  meeting: "Meetings",
  entity: "Entities",
  goal: "Goals",
  data: "Datasets",
  skill: "Skills",
  credential: "Credentials",
};

export function kindLabelPlural(kind: string, types: readonly Pick<RecordTypeDefinition, "key" | "label" | "label_plural">[]): string {
  const type = types.find((t) => t.key === kind);
  if (type) return type.label_plural || `${type.label}s`;
  return CORE_LABELS[kind] ?? kind;
}

/**
 * What a dataset table says instead of "Convert to …" when no node record
 * type fits its rows (the API only offers targets that share compatible
 * fields — `promoteTargetsFor`). Null when there is a target: the button is
 * the explanation then.
 */
export function promoteUnavailableNote(
  type: Pick<RecordTypeDefinition, "key" | "label" | "label_plural">,
  targets: readonly unknown[],
): string | null {
  if (targets.length > 0) return null;
  const plural = type.label_plural || `${type.label}s`;
  return `${plural} stay rows: no node record type shares compatible fields with them, so none can be converted to a node. Add a node type with some of the same fields (name, email…) to make that possible.`;
}

/**
 * Everything related to one record, grouped by kind: what its own relation
 * fields point at, the records whose relation fields point at it, and the
 * plain links (mentions, edges) the knowledge graph already has. One item
 * appears once per group even when it is related three ways; the first way
 * found names it. Groups come in record-type order, then core kinds, with
 * decisions last — they are the "why" under the "what".
 */
export function relatedGroups(input: RelatedInput): RelatedGroup[] {
  const byKind = new Map<string, Map<string, RelatedItem>>();
  const add = (item: RelatedItem) => {
    if (item.id === input.node.id) return;
    const group = byKind.get(item.kind) ?? new Map<string, RelatedItem>();
    if (!group.has(item.id)) group.set(item.id, item);
    byKind.set(item.kind, group);
  };
  const stageOf = (record: RecordNodeLike): string | null => {
    const type = recordTypeFor(record.kind, input.types);
    if (!type?.stage_field) return null;
    const value = fieldsOf(record)[type.stage_field];
    return typeof value === "string" ? value : null;
  };

  // 1. This record's own relation fields.
  if (input.type) {
    const fields = fieldsOf(input.node);
    for (const def of input.type.fields) {
      if (def.type !== "relation") continue;
      for (const id of relationIds(fields[def.key])) {
        const known = input.index.get(id) ?? input.records.find((r) => r.id === id);
        if (!known) continue;
        const record = input.records.find((r) => r.id === id);
        add({ id, kind: known.kind, title: known.title, via: def.label, stage: record ? stageOf(record) : null, status: known.status ?? null });
      }
    }
  }

  // 2. Records whose relation fields point here.
  for (const record of input.records) {
    const type = recordTypeFor(record.kind, input.types);
    if (!type) continue;
    const fields = fieldsOf(record);
    for (const def of type.fields) {
      if (def.type !== "relation") continue;
      if (relationIds(fields[def.key]).includes(input.node.id)) {
        add({ id: record.id, kind: record.kind, title: record.title, via: def.label, stage: stageOf(record), status: record.status ?? null });
        break;
      }
    }
  }

  // 3. Mentions and edges.
  for (const link of input.links) {
    const known = input.index.get(link.id);
    const kind = link.kind ?? known?.kind;
    if (!kind) continue;
    add({ id: link.id, kind, title: link.title ?? known?.title ?? link.id, via: link.via, status: known?.status ?? null });
  }

  const typeOrder = input.types.map((type) => type.key);
  const order = (kind: string) => {
    const index = typeOrder.indexOf(kind);
    if (index >= 0) return index;
    if (kind === "decision" || kind === "adr") return 10_000;
    return 1_000;
  };
  return [...byKind.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([kind, items]) => ({ kind, label: kindLabelPlural(kind, input.types), items: [...items.values()] }));
}

/* -------------------------------------------------------------------------- */
/*  MRR history from events                                                    */
/* -------------------------------------------------------------------------- */

export interface MrrPoint {
  /** YYYY-MM */
  period: string;
  mrr: number;
}

/**
 * One customer's MRR at the end of each of the last `months` months, rebuilt
 * from their subscription events with the same rules the rollup uses
 * (`events.ts`): `started`/`changed` set a subscription's MRR, `canceled`
 * zeroes it, and the customer's MRR is the sum over subscriptions (one
 * subscription when `subscription_id` is omitted). Amounts in another
 * currency than the reporting one are left out, as the rollup does.
 */
export function mrrHistory(events: readonly Pick<BusinessEvent, "type" | "occurred_at" | "amount" | "currency" | "properties">[], currency: string, now: Date, months = 12): MrrPoint[] {
  const subscriptionEvents = events
    .filter((event) => event.type.startsWith("subscription."))
    .filter((event) => event.type === "subscription.canceled" || (event.currency ?? currency) === currency)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const periods: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const subs = new Map<string, number>();
  let cursor = 0;
  return periods.map((period) => {
    const [y, m] = period.split("-").map(Number);
    const end = Date.UTC(y!, m!, 1); // first instant of the next month
    while (cursor < subscriptionEvents.length && Date.parse(subscriptionEvents[cursor]!.occurred_at) < end) {
      const event = subscriptionEvents[cursor]!;
      const sub = typeof event.properties?.subscription_id === "string" ? event.properties.subscription_id : "_default";
      if (event.type === "subscription.canceled") subs.set(sub, 0);
      else if (typeof event.amount === "number") subs.set(sub, Math.max(0, event.amount));
      cursor += 1;
    }
    let mrr = 0;
    for (const value of subs.values()) mrr += value;
    return { period, mrr };
  });
}

/** One line for an event in a timeline: what happened, in words. */
export function describeEvent(
  event: Pick<BusinessEvent, "type" | "amount" | "currency" | "properties"> & { role?: "subject" | "supplier" },
  currency: string,
): string {
  const money = typeof event.amount === "number" ? formatMoney(event.amount, event.currency ?? currency) : null;
  const props = event.properties ?? {};
  switch (event.type) {
    case "subscription.started":
      return `Subscription started${money ? ` · ${money}/mo` : ""}`;
    case "subscription.changed":
      return `Subscription changed${money ? ` → ${money}/mo` : ""}`;
    case "subscription.canceled":
      return "Subscription canceled";
    case "booking.created":
      return `${event.role === "supplier" ? "Booked with them" : "Booking"}${money ? ` · ${money}` : ""}`;
    case "booking.completed":
      return "Booking completed";
    case "booking.canceled":
      return "Booking canceled";
    case "expense.recorded":
      return `Expense${typeof props.category === "string" ? ` · ${props.category}` : ""}${money ? ` · ${money}` : ""}`;
    case "cash.balance":
      return `Cash balance${money ? ` · ${money}` : ""}`;
    default:
      return `${event.type}${money ? ` · ${money}` : ""}`;
  }
}
