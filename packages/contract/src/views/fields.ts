/**
 * Record views as a pure model: what a table or board over record types
 * shows, given the record types and each record's `fields`. Column order of
 * a stage board, the column a card falls in, the `fields` patch a drag
 * produces, per-column totals ("Proposal · 3 · €2,100/mo"), sorting on a
 * field and the display text of a value.
 *
 * Who uses it: the web's record board / record table / dataset table render
 * from it; the API uses `recordViewFieldRefs` to check a saved view against
 * the workspace's record types. Same rules on both sides, so a drop the UI
 * allows is a patch the node update accepts (`validateRecordFields`).
 *
 * Must not break: a money total never adds two currencies together — a
 * mixed column says so instead of printing a wrong number — and a value
 * outside a select's options still shows up (in a "no value" column), it is
 * never dropped from the board.
 */
import type {
  MoneyValue,
  RecordFieldDef,
  RecordFields,
  RecordFieldValue,
  RecordTypeDefinition,
} from "../business/record-types.js";
import { parseFieldRef, type ViewPresentation } from "./schema.js";

/** One row of a record view: a node record or a dataset row. */
export interface RecordRow {
  /** Node id, or the dataset row key. */
  id: string;
  title: string;
  /** The record type key (the node's kind). */
  type: string;
  fields: RecordFields;
}

export const NO_VALUE_COLUMN = "__none__";

/* -------------------------------------------------------------------------- */
/*  Which fields a view talks about                                           */
/* -------------------------------------------------------------------------- */

/** Every `field:<key>` the presentation names: group_by, sort_by, columns. */
export function recordViewFieldRefs(presentation: Pick<ViewPresentation, "group_by" | "sort_by" | "columns">): string[] {
  const refs = [
    parseFieldRef(presentation.group_by),
    ...presentation.sort_by.map((sort) => parseFieldRef(sort.field)),
    ...presentation.columns.map((column) => parseFieldRef(column)),
  ];
  return [...new Set(refs.filter((key): key is string => Boolean(key)))];
}

/**
 * The definition of a field across the types a view shows. Two types may
 * both declare `status`; the first wins, which is the one the view lists
 * first in `kinds`.
 */
export function findFieldDef(
  types: readonly Pick<RecordTypeDefinition, "key" | "fields">[],
  key: string,
): RecordFieldDef | null {
  for (const type of types) {
    const field = type.fields.find((candidate) => candidate.key === key);
    if (field) return field;
  }
  return null;
}

/**
 * The columns a record table shows: the ones the view names, else every
 * field of its first type. Core columns (`title`, `status`…) pass through as
 * `{ core }` so the renderer can mix them.
 */
export type RecordColumn = { field: RecordFieldDef } | { core: string };

export function recordTableColumns(
  types: readonly Pick<RecordTypeDefinition, "key" | "fields">[],
  presentation: Pick<ViewPresentation, "columns">,
): RecordColumn[] {
  if (presentation.columns.length === 0) {
    return [{ core: "title" }, ...(types[0]?.fields ?? []).map((field) => ({ field }))];
  }
  const out: RecordColumn[] = [];
  for (const column of presentation.columns) {
    const key = parseFieldRef(column);
    if (!key) {
      out.push({ core: column });
      continue;
    }
    const field = findFieldDef(types, key);
    if (field) out.push({ field });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Board                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordBoardColumn {
  /** The select option, or `NO_VALUE_COLUMN`. */
  value: string;
  label: string;
}

/**
 * The field a record board groups by: `group_by: field:<key>` when given,
 * else the first type's `stage_field`. Null when neither names a select
 * field — then the view is not a record board.
 */
export function recordBoardField(
  types: readonly Pick<RecordTypeDefinition, "key" | "fields" | "stage_field">[],
  presentation: Pick<ViewPresentation, "group_by">,
): RecordFieldDef | null {
  const explicit = parseFieldRef(presentation.group_by);
  const key = explicit ?? (presentation.group_by ? null : types.find((type) => type.stage_field)?.stage_field ?? null);
  if (!key) return null;
  const field = findFieldDef(types, key);
  return field && (field.type === "select" || field.type === "person" || field.type === "boolean") ? field : null;
}

/**
 * Columns in the field's option order — the pipeline's order, which is the
 * point of a stage board. A "No value" column is added only when some record
 * needs it, so a clean pipeline has no empty bucket at its end.
 */
export function recordBoardColumns(field: RecordFieldDef, rows: readonly RecordRow[]): RecordBoardColumn[] {
  const options = field.type === "boolean" ? ["true", "false"] : field.options ?? [];
  const columns = options.map((value) => ({ value, label: field.type === "boolean" ? (value === "true" ? "Yes" : "No") : value }));
  if (field.type === "person") {
    const people = [...new Set(rows.map((row) => row.fields[field.key]).filter((v): v is string => typeof v === "string" && v.length > 0))];
    columns.push(...people.sort().map((value) => ({ value, label: value })));
  }
  const known = new Set(columns.map((column) => column.value));
  if (rows.some((row) => !known.has(boardValueOf(row, field)))) {
    columns.push({ value: NO_VALUE_COLUMN, label: "No value" });
  }
  return columns;
}

export function boardValueOf(row: RecordRow, field: RecordFieldDef): string {
  const value = row.fields[field.key];
  if (value === null || value === undefined || value === "") return NO_VALUE_COLUMN;
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : NO_VALUE_COLUMN;
}

export function groupRecordRows(
  field: RecordFieldDef,
  rows: readonly RecordRow[],
  columns: readonly RecordBoardColumn[],
  optimistic: Readonly<Record<string, string>> = {},
): Map<string, RecordRow[]> {
  const groups = new Map(columns.map((column) => [column.value, [] as RecordRow[]]));
  for (const row of rows) {
    const value = optimistic[row.id] ?? boardValueOf(row, field);
    const target = groups.has(value) ? value : NO_VALUE_COLUMN;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target)!.push(row);
  }
  return groups;
}

/**
 * The `fields` patch a drop into a column means — sent as
 * `PATCH /api/nodes/:id { fields }`. Null when the drop is not an edit (the
 * same column, or a value the field cannot take).
 */
export function recordMovePatch(
  field: RecordFieldDef,
  row: RecordRow,
  columnValue: string,
): Record<string, RecordFieldValue> | null {
  if (boardValueOf(row, field) === columnValue) return null;
  if (columnValue === NO_VALUE_COLUMN) return field.required ? null : { [field.key]: null };
  if (field.type === "boolean") return columnValue === "true" || columnValue === "false" ? { [field.key]: columnValue === "true" } : null;
  if (field.type === "select" && !(field.options ?? []).includes(columnValue)) return null;
  return { [field.key]: columnValue };
}

/* -------------------------------------------------------------------------- */
/*  Totals                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Number keys whose values are rates or grades: their column total is an
 * average (a sum of 4.8 + 4.6 + … ratings is the "Σ 78.1" nobody can read).
 */
const AVERAGE_KEY = /(^|_)(rating|ratings|score|scores|stars|probability|prob|percent|percentage|pct|rate|ratio|nps|csat|satisfaction|margin|conversion)(_|$)/;
/** Number keys that are labels or coordinates: no total at all. */
const NO_TOTAL_KEY = /(^|_)(year|rank|ranking|position|order|index|age|lat|lng|lon|latitude|longitude|zip|postcode|code|id|number|version|priority)(_|$)/;

/**
 * What a number or money column totals to: the field's own `total` when
 * the definition says, else money sums and a number is inferred from its
 * key — rates and grades average, labels show nothing, and everything else
 * (counts, sizes, weights, amounts) sums. Null for a field that is neither.
 */
export function fieldTotalOf(field: Pick<RecordFieldDef, "key" | "type" | "total">): "sum" | "average" | "none" | null {
  if (field.type !== "number" && field.type !== "money") return null;
  if (field.total) return field.total;
  if (field.type === "money") return "sum";
  if (AVERAGE_KEY.test(field.key)) return "average";
  if (NO_TOTAL_KEY.test(field.key)) return "none";
  return "sum";
}

export interface FieldTotal {
  field: string;
  label: string;
  type: "number" | "money";
  /** How the column totals (`fieldTotalOf`); `none` columns are not listed. */
  op: "sum" | "average";
  /** Sum of the values present; null when none has one. */
  sum: number | null;
  /** Mean of the values present; null when none has one. */
  average: number | null;
  /** How many rows carry a value. */
  count: number;
  /** money: the one currency summed; null when mixed (then `sum` is null). */
  currency: string | null;
  mixed_currency: boolean;
}

export interface RowTotals {
  count: number;
  totals: FieldTotal[];
}

/**
 * Count of rows plus a total per number/money field that has a meaningful
 * one (`fieldTotalOf`) — table footers and board column headers.
 */
export function totalsFor(fields: readonly RecordFieldDef[], rows: readonly RecordRow[]): RowTotals {
  const totals: FieldTotal[] = [];
  for (const field of fields) {
    const op = fieldTotalOf(field);
    if (op === null || op === "none" || (field.type !== "number" && field.type !== "money")) continue;
    let sum: number | null = null;
    let count = 0;
    const currencies = new Set<string>();
    for (const row of rows) {
      const value = row.fields[field.key];
      const amount = field.type === "money" ? moneyAmount(value) : typeof value === "number" ? value : null;
      if (amount === null) continue;
      if (field.type === "money") currencies.add((value as MoneyValue).currency);
      sum = (sum ?? 0) + amount;
      count++;
    }
    const mixed = currencies.size > 1;
    totals.push({
      field: field.key,
      label: field.label,
      type: field.type,
      op,
      sum: mixed ? null : sum,
      average: mixed || sum === null || count === 0 ? null : sum / count,
      count,
      currency: field.type === "money" && !mixed ? [...currencies][0] ?? null : null,
      mixed_currency: mixed,
    });
  }
  return { count: rows.length, totals };
}

/**
 * The one total a board column header shows: the field the layout names
 * (`layout.board.total_field`), else the first summed money field, else the
 * first summed number field. An average is shown only when named.
 */
export function headlineTotal(totals: RowTotals, preferred?: string | null): FieldTotal | null {
  if (preferred) {
    const named = totals.totals.find((total) => total.field === preferred);
    if (named) return named;
  }
  const summed = totals.totals.filter((total) => total.op === "sum");
  return summed.find((total) => total.type === "money") ?? summed.find((total) => total.type === "number") ?? null;
}

/**
 * A total as text: "Σ €2,100" for a sum, "avg 4.7" for an average (one
 * decimal, as a grade is read), "mixed currencies" when a money column
 * holds two. Empty when no row has a value.
 */
export function totalText(total: FieldTotal, locale?: string): string {
  if (total.mixed_currency) return "mixed currencies";
  if (total.op === "average") {
    if (total.average === null) return "";
    const text = total.type === "money"
      ? formatMoney(total.average, total.currency ?? "EUR", locale)
      : new Intl.NumberFormat(locale ?? DISPLAY_LOCALE, { maximumFractionDigits: 1 }).format(total.average);
    return `avg ${text}`;
  }
  if (total.sum === null) return "";
  return `Σ ${total.type === "money" ? formatMoney(total.sum, total.currency ?? "EUR", locale) : formatNumber(total.sum, locale)}`;
}

/** "Proposal · 3 · €2,100/mo" — `suffix` is the layout's (`/mo` for MRR). */
export function columnSummary(label: string, totals: RowTotals, headline: FieldTotal | null, suffix = "", locale?: string): string {
  const parts = [label, String(totals.count)];
  if (headline && headline.count > 0) {
    if (headline.mixed_currency) parts.push("mixed currencies");
    else if (headline.op === "average") {
      if (headline.average !== null) parts.push(totalText(headline, locale));
    } else if (headline.sum !== null) {
      parts.push((headline.type === "money" ? formatMoney(headline.sum, headline.currency ?? "EUR", locale) : formatNumber(headline.sum, locale)) + suffix);
    }
  }
  return parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/*  Sorting                                                                   */
/* -------------------------------------------------------------------------- */

function sortKey(value: RecordFieldValue | undefined): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  const money = moneyAmount(value);
  if (money !== null) return money;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  return String(value).toLocaleLowerCase("en-US");
}

/**
 * Sort rows by the presentation's `sort_by`; `field:<key>` sorts on the
 * field (selects by option order, so "lead → won" reads as a pipeline), a
 * core `title` on the title. Empty values go last in both directions.
 */
export function sortRecordRows(
  rows: readonly RecordRow[],
  sortBy: ViewPresentation["sort_by"],
  types: readonly Pick<RecordTypeDefinition, "key" | "fields">[],
): RecordRow[] {
  if (sortBy.length === 0) return [...rows];
  const comparators = sortBy.map((sort) => {
    const key = parseFieldRef(sort.field);
    const field = key ? findFieldDef(types, key) : null;
    const dir = sort.direction === "desc" ? -1 : 1;
    return (a: RecordRow, b: RecordRow): number => {
      let left: number | string | null;
      let right: number | string | null;
      if (field?.type === "select") {
        const options = field.options ?? [];
        const index = (row: RecordRow) => {
          const at = options.indexOf(String(row.fields[field.key] ?? ""));
          return at === -1 ? null : at;
        };
        left = index(a);
        right = index(b);
      } else if (key) {
        left = sortKey(a.fields[key]);
        right = sortKey(b.fields[key]);
      } else {
        left = sort.field === "title" ? a.title.toLocaleLowerCase("en-US") : null;
        right = sort.field === "title" ? b.title.toLocaleLowerCase("en-US") : null;
      }
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * dir;
    };
  });
  return [...rows].sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return a.title.localeCompare(b.title);
  });
}

/* -------------------------------------------------------------------------- */
/*  Display                                                                   */
/* -------------------------------------------------------------------------- */

export function moneyAmount(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = (value as { amount?: unknown }).amount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

/**
 * The locale record values are written in when the caller names none: the
 * web's own (`apps/web/src/lib/business/format.ts`), so a board, a table
 * and the dashboard print €1,990 the same way whatever the browser's
 * language, and a server render agrees with the client.
 */
export const DISPLAY_LOCALE = "en-US";

export interface MoneyFormatOptions {
  locale?: string;
  /** `€12.3K`: for chart axes and the large figure of a narrow KPI card. */
  compact?: boolean;
}

/**
 * THE money formatter: every amount the business UI shows — record cells,
 * table and board totals, KPI cards, charts, the event timeline — goes
 * through it, so "€90" never sits next to "€150.00".
 *
 * The decimals rule: an amount with cents shows them, both digits (€49.90),
 * up to 1,000; a whole amount (or one from 1,000 up) shows none (€90,
 * €1,241). Compact notation keeps at most one decimal (€12.3K).
 */
export function formatMoney(amount: number, currency: string, opts: string | MoneyFormatOptions = {}): string {
  const { locale = DISPLAY_LOCALE, compact = false } = typeof opts === "string" ? { locale: opts } : opts;
  const cents = Math.abs(amount) < 1000 && Math.round(Math.abs(amount) * 100) % 100 !== 0;
  try {
    return new Intl.NumberFormat(locale, compact
      ? { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }
      : { style: "currency", currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 },
    ).format(amount);
  } catch {
    // An unknown ISO code (the schema only checks the shape) still prints.
    return `${formatNumber(amount, locale)} ${currency}`;
  }
}

export function formatNumber(value: number, locale: string = DISPLAY_LOCALE): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** `2026-03-04` → "4 Mar 2026"; a timestamp drops its time. UTC, so a date never shifts a day. */
export function formatDateValue(value: string, locale: string = DISPLAY_LOCALE): string {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
}

export type DisplayValue =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "chips"; values: string[] }
  | { kind: "relation"; ids: string[] }
  | { kind: "link"; href: string; text: string };

/**
 * What a cell shows, before any markup: the renderer turns `chips` into
 * chips and `relation` ids into links to the nodes. Values that do not
 * match their field's type (written before a definition changed) are shown
 * as text rather than hidden.
 */
export function displayFieldValue(field: Pick<RecordFieldDef, "type">, value: RecordFieldValue | undefined, locale?: string): DisplayValue {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return { kind: "empty" };
  switch (field.type) {
    case "money": {
      const amount = moneyAmount(value);
      return amount === null ? { kind: "text", text: String(value) } : { kind: "text", text: formatMoney(amount, (value as MoneyValue).currency, locale) };
    }
    case "number":
      return typeof value === "number" ? { kind: "text", text: formatNumber(value, locale) } : { kind: "text", text: String(value) };
    case "date":
      return { kind: "text", text: typeof value === "string" ? formatDateValue(value, locale) : String(value) };
    case "boolean":
      return { kind: "text", text: value === true ? "Yes" : value === false ? "No" : String(value) };
    case "select":
      return { kind: "chips", values: [String(value)] };
    case "multi_select":
      return { kind: "chips", values: Array.isArray(value) ? value.map(String) : [String(value)] };
    case "relation":
      return { kind: "relation", ids: Array.isArray(value) ? value.map(String) : [String(value)] };
    case "url":
      return typeof value === "string" ? { kind: "link", href: value, text: value.replace(/^https?:\/\//i, "") } : { kind: "text", text: String(value) };
    case "email":
      return typeof value === "string" ? { kind: "link", href: `mailto:${value}`, text: value } : { kind: "text", text: String(value) };
    default:
      return { kind: "text", text: typeof value === "object" ? JSON.stringify(value) : String(value) };
  }
}
