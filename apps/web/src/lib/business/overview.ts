/**
 * The SaaS-first overview's model: which KPIs lead for each business model,
 * the series behind its charts, and the action lists (accounts at risk,
 * renewals, weighted pipeline, under-supplied zones…) derived from records.
 *
 * Who uses it: `components/business/business-overview.tsx` (server) and its
 * tests. Pure functions over the contract's `MetricsSummary` and record
 * nodes; no fetch, no React.
 *
 * The numbers are the API's (`metrics/summary`): this file picks and pairs
 * them, it never recomputes a KPI. The action lists are the one thing
 * derived here, because they are lists of records, not metrics — and they
 * find their record types by role (`findRole`), not by a fixed key, so a
 * template that says `client` instead of `account` still gets them.
 *
 * Must not break: an empty or missing summary is the "no data yet" state,
 * not an error, and a list whose record type does not exist is simply not
 * shown (`null`), never an empty box claiming there is nothing at risk.
 */
import type { KpiValue, MetricsSummary } from "@bcontext-dev/contract/business/metrics";
import type { BusinessModel, RecordFieldDef, RecordTypeDefinition } from "@bcontext-dev/contract/business/record-types";
import { fieldsOf, numericValue, relationFieldsTo, relationIds, type RecordNodeLike } from "./records";
import { periodLabel } from "./format";

/* -------------------------------------------------------------------------- */
/*  KPIs                                                                      */
/* -------------------------------------------------------------------------- */

export interface TopKpi {
  /** The headline KPI. */
  key: string;
  /** Shown under it, smaller: the KPI that keeps the headline honest. */
  secondary: string[];
  /** Compare with a year ago instead of last month (seasonal businesses). */
  yoy?: boolean;
}

/**
 * The top row per model. B2B and B2C read the same SaaS set: a B2C business
 * is a SaaS one over more, smaller customers; what differs is below the row
 * (no pipeline). The marketplace compares GMV with the same month last
 * season because its months are not comparable with each other.
 */
export const TOP_KPIS: Record<Exclude<BusinessModel, "product">, TopKpi[]> = {
  b2b: [
    { key: "mrr", secondary: ["net_new_mrr"] },
    { key: "new_customers", secondary: ["active_customers"] },
    { key: "revenue_churn_rate", secondary: ["logo_churn_rate"] },
    { key: "net", secondary: ["burn", "runway_months"] },
  ],
  b2c: [
    { key: "mrr", secondary: ["net_new_mrr"] },
    { key: "new_customers", secondary: ["active_customers"] },
    { key: "revenue_churn_rate", secondary: ["logo_churn_rate"] },
    { key: "net", secondary: ["burn", "runway_months"] },
  ],
  marketplace: [
    { key: "gmv", secondary: [], yoy: true },
    { key: "take", secondary: ["take_rate"] },
    { key: "bookings", secondary: ["cancellation_rate"] },
    { key: "net", secondary: ["expenses"] },
  ],
};

export function kpiMap(summary: MetricsSummary | null): Map<string, KpiValue> {
  return new Map((summary?.kpis ?? []).map((kpi) => [kpi.key, kpi]));
}

/**
 * Has anything been measured? The rollup has never run, or ran over no
 * events, when every KPI is null for every month — the empty state, which
 * explains how to send data instead of showing a wall of dashes.
 */
export function summaryHasData(summary: MetricsSummary | null): boolean {
  if (!summary) return false;
  return summary.kpis.some((kpi) => kpi.current !== null || kpi.series.some((point) => point.value !== null && point.value !== 0));
}

/** One row of the MRR chart: the line, and the four movements as bars. */
export interface MrrMovementPoint {
  period: string;
  label: string;
  mrr: number | null;
  new_mrr: number;
  expansion_mrr: number;
  /** Negative, so the bars hang below the axis. */
  contraction_mrr: number;
  /** Negative, so the bars hang below the axis. */
  churned_mrr: number;
}

export function mrrMovementSeries(summary: MetricsSummary | null): MrrMovementPoint[] {
  const kpis = kpiMap(summary);
  const mrr = kpis.get("mrr")?.series ?? [];
  const at = (key: string, period: string) => kpis.get(key)?.series.find((p) => p.period === period)?.value ?? 0;
  return mrr.map((point) => ({
    period: point.period,
    label: periodLabel(point.period),
    mrr: point.value,
    new_mrr: at("new_mrr", point.period),
    expansion_mrr: at("expansion_mrr", point.period),
    contraction_mrr: -Math.abs(at("contraction_mrr", point.period)),
    churned_mrr: -Math.abs(at("churned_mrr", point.period)),
  }));
}

export interface SeasonPoint {
  period: string;
  label: string;
  gmv: number | null;
  bookings: number | null;
}

/** GMV and bookings, month by month over the last twelve. */
export function seasonSeries(summary: MetricsSummary | null): SeasonPoint[] {
  const kpis = kpiMap(summary);
  const gmv = kpis.get("gmv")?.series ?? [];
  const bookings = kpis.get("bookings")?.series ?? [];
  return gmv.map((point) => ({
    period: point.period,
    label: periodLabel(point.period),
    gmv: point.value,
    bookings: bookings.find((p) => p.period === point.period)?.value ?? null,
  }));
}

/** Expenses of the month by category, largest first. */
export function expensesByCategory(summary: MetricsSummary | null): { category: string; amount: number }[] {
  return Object.entries(summary?.expenses_by_category ?? {})
    .map(([category, amount]) => ({ category, amount }))
    .filter((row) => Number.isFinite(row.amount) && row.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export type RecordRole = "customer" | "deal" | "request" | "incident" | "supplier" | "buyer" | "zone";

/**
 * Keys that name a role, most specific first. A template is free to call
 * its types anything; these are the names templates and people actually
 * use, and the first type whose key matches wins.
 */
const ROLE_KEYS: Record<RecordRole, RegExp> = {
  customer: /^(account|customer|client|company|organization|organisation|subscriber)s?$/,
  deal: /^(deal|opportunity|opportunities|lead)s?$/,
  request: /^(request|feature_request|feedback|idea)s?$/,
  incident: /^(incident|ticket|issue|support_ticket|case)s?$/,
  supplier: /^(supplier|provider|host|vendor|seller|partner)s?$/,
  buyer: /^(buyer|guest|customer|client)s?$/,
  zone: /^(zone|area|region|city|location|market)s?$/,
};

export function findRole<T extends Pick<RecordTypeDefinition, "key">>(types: readonly T[], role: RecordRole): T | null {
  return types.find((type) => ROLE_KEYS[role].test(type.key)) ?? null;
}

/** The first field of `type` whose key matches, optionally of given types. */
export function findField(
  type: Pick<RecordTypeDefinition, "fields"> | null,
  key: RegExp,
  fieldTypes?: readonly RecordFieldDef["type"][],
): RecordFieldDef | null {
  if (!type) return null;
  return type.fields.find((field) => key.test(field.key) && (!fieldTypes || fieldTypes.includes(field.type))) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Action lists                                                              */
/* -------------------------------------------------------------------------- */

export interface ActionRow {
  id: string;
  kind: string;
  title: string;
  /** The figure on the right: an amount, a date, a count. */
  chip: string;
  tone?: "default" | "warning" | "danger" | "accent";
  /** Numeric weight the list was sorted by (MRR, weighted value…). */
  weight?: number;
}

const RISK_VALUE = /risk|red|churn|critical|poor|bad|unhealthy/i;
const HEALTH_KEY = /^(health|health_score|risk|status|churn_risk|sentiment)$/;
const GONE_VALUE = /^(churned|canceled|cancelled|lost|closed|archived)$/i;
const CLOSED_VALUE = /^(won|lost|closed|closed_won|closed_lost|done|resolved|canceled|cancelled|churned|archived)$/i;
const WON_VALUE = /^(won|closed_won)$/i;

function selectValue(node: RecordNodeLike, field: RecordFieldDef | null): string | null {
  if (!field) return null;
  const value = fieldsOf(node)[field.key];
  return typeof value === "string" ? value : null;
}

function moneyOf(node: RecordNodeLike, field: RecordFieldDef | null): number | null {
  return field ? numericValue(fieldsOf(node)[field.key]) : null;
}

/** The customer type's MRR-like field: `mrr`, `arr`/12, or a monthly amount. */
export function customerMrrField(type: Pick<RecordTypeDefinition, "fields"> | null): RecordFieldDef | null {
  return findField(type, /^(mrr|monthly_revenue|monthly_amount|plan_amount)$/, ["money", "number"]);
}

/**
 * Customers at risk: any health-like field (`health`, `status`, `risk`…)
 * whose value reads as risk, or the node's own status `at_risk`. Every such
 * field counts — the b2b template has both `status` (`at_risk`) and `health`
 * (`red`), and an account that is `active` but `red` is at risk. Ordered by
 * MRR, because the one to call first is the one that costs most to lose.
 */
export function accountsAtRisk(
  accounts: readonly RecordNodeLike[],
  type: Pick<RecordTypeDefinition, "fields" | "stage_field"> | null,
  format: (amount: number) => string,
): ActionRow[] | null {
  if (!type) return null;
  const healthFields = type.fields.filter((field) => HEALTH_KEY.test(field.key) && (field.type === "select" || field.type === "text"));
  const mrrField = customerMrrField(type);
  const riskOf = (account: RecordNodeLike): string | null => {
    // A churned account is gone, not at risk: `/churn/` is for values like
    // `churn_risk`, never for the terminal state.
    if (healthFields.some((field) => GONE_VALUE.test(selectValue(account, field) ?? ""))) return null;
    for (const field of healthFields) {
      const value = selectValue(account, field);
      if (value !== null && RISK_VALUE.test(value)) return value;
    }
    return account.status === "at_risk" ? "at risk" : null;
  };
  return accounts
    .map((account) => ({ account, risk: riskOf(account) }))
    .filter((row): row is { account: RecordNodeLike; risk: string } => row.risk !== null)
    .map(({ account, risk }) => {
      const mrr = moneyOf(account, mrrField);
      return { id: account.id, kind: account.kind, title: account.title, chip: mrr !== null ? format(mrr) : risk, tone: "danger" as const, weight: mrr ?? 0 };
    })
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

/** Customers whose renewal date falls in the current month (UTC). */
export function renewalsThisMonth(
  accounts: readonly RecordNodeLike[],
  type: Pick<RecordTypeDefinition, "fields"> | null,
  now: Date,
): ActionRow[] | null {
  const field = findField(type, /renew/, ["date"]);
  if (!type || !field) return null;
  const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return accounts
    .map((account) => ({ account, date: fieldsOf(account)[field.key] }))
    .filter((row): row is { account: RecordNodeLike; date: string } => typeof row.date === "string" && row.date.startsWith(prefix))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ account, date }) => {
      const day = Number(date.slice(8, 10));
      const overdue = day < now.getUTCDate();
      return { id: account.id, kind: account.kind, title: account.title, chip: overdue ? `${date.slice(8, 10)} · past` : `${periodLabel(prefix)} ${day}`, tone: overdue ? ("warning" as const) : ("default" as const) };
    });
}

/**
 * Requests ranked by the MRR of the customers asking for them. A request
 * relates to customers through a relation field on either side (the request
 * lists its accounts, or the account lists its requests); both count, once.
 */
export function topRequestsByMrr(
  requests: readonly RecordNodeLike[],
  requestType: Pick<RecordTypeDefinition, "key" | "fields" | "stage_field"> | null,
  accounts: readonly RecordNodeLike[],
  accountType: Pick<RecordTypeDefinition, "key" | "fields"> | null,
  format: (amount: number) => string,
): ActionRow[] | null {
  if (!requestType || !accountType) return null;
  const mrrField = customerMrrField(accountType);
  const mrrById = new Map(accounts.map((account) => [account.id, moneyOf(account, mrrField) ?? 0]));
  const fromRequest = relationFieldsTo(requestType, accountType.key);
  const fromAccount = relationFieldsTo(accountType, requestType.key);
  const stage = requestType.stage_field ? requestType.fields.find((f) => f.key === requestType.stage_field) ?? null : null;
  return requests
    .filter((request) => !CLOSED_VALUE.test(selectValue(request, stage) ?? "") && request.status !== "done" && request.status !== "archived")
    .map((request) => {
      const askers = new Set<string>();
      for (const field of fromRequest) for (const id of relationIds(fieldsOf(request)[field.key])) askers.add(id);
      for (const account of accounts) {
        for (const field of fromAccount) if (relationIds(fieldsOf(account)[field.key]).includes(request.id)) askers.add(account.id);
      }
      let mrr = 0;
      for (const id of askers) mrr += mrrById.get(id) ?? 0;
      return { request, mrr, askers: askers.size };
    })
    .filter((row) => row.askers > 0)
    .sort((a, b) => b.mrr - a.mrr || b.askers - a.askers)
    .map(({ request, mrr, askers }) => ({ id: request.id, kind: request.kind, title: request.title, chip: mrr > 0 ? format(mrr) : `${askers} asking`, tone: "accent" as const, weight: mrr }));
}

/**
 * Open bugs a customer is affected by: core `bug` nodes that any record
 * points at through a relation field, counted per distinct customer reached
 * (directly when the record is a customer, or through its own relation to
 * one). `bugs` is the node index's open bugs.
 */
export function bugsAffectingCustomers(
  bugs: readonly RecordNodeLike[],
  records: readonly RecordNodeLike[],
  types: readonly Pick<RecordTypeDefinition, "key" | "fields">[],
  customerKey: string | null,
): ActionRow[] | null {
  if (!customerKey) return null;
  const open = new Map(bugs.filter((bug) => bug.status !== "done" && bug.status !== "archived").map((bug) => [bug.id, bug]));
  if (open.size === 0) return [];
  const affected = new Map<string, Set<string>>();
  for (const record of records) {
    const type = types.find((t) => t.key === record.kind);
    if (!type) continue;
    const fields = fieldsOf(record);
    const bugIds = relationFieldsTo(type, "bug").flatMap((field) => relationIds(fields[field.key])).filter((id) => open.has(id));
    if (bugIds.length === 0) continue;
    const customers = record.kind === customerKey
      ? [record.id]
      : relationFieldsTo(type, customerKey).flatMap((field) => relationIds(fields[field.key]));
    for (const bugId of bugIds) {
      const set = affected.get(bugId) ?? new Set<string>();
      for (const id of customers) set.add(id);
      if (customers.length === 0) set.add(`record:${record.id}`);
      affected.set(bugId, set);
    }
  }
  return [...affected.entries()]
    .map(([bugId, set]) => ({ bug: open.get(bugId)!, count: set.size }))
    .sort((a, b) => b.count - a.count)
    .map(({ bug, count }) => ({ id: bug.id, kind: bug.kind, title: bug.title, chip: `${count} affected`, tone: "warning" as const, weight: count }));
}

export interface PipelineStage {
  stage: string;
  count: number;
  value: number;
  weighted: number;
}

export interface WeightedPipeline {
  stages: PipelineStage[];
  total: number;
  weighted: number;
  /** Open deals, largest weighted value first. */
  deals: ActionRow[];
}

/**
 * The open pipeline, by stage. A deal's weight is its own `probability`
 * field (a 0–1 fraction or a 0–100 percent) when it has one; otherwise its
 * stage's position in the stage list, so a later stage weighs more. Won and
 * lost deals are not pipeline.
 */
export function weightedPipeline(
  deals: readonly RecordNodeLike[],
  type: Pick<RecordTypeDefinition, "fields" | "stage_field"> | null,
  format: (amount: number) => string,
): WeightedPipeline | null {
  if (!type) return null;
  const stageField = type.stage_field ? type.fields.find((f) => f.key === type.stage_field) ?? null : null;
  const amountField = findField(type, /^(amount|value|deal_value|arr|mrr|size)$/, ["money", "number"]);
  const probabilityField = findField(type, /^(probability|win_probability|likelihood|confidence)$/, ["number"]);
  const options = (stageField?.options ?? []).filter((option) => !CLOSED_VALUE.test(option));
  const stages = new Map<string, PipelineStage>(options.map((stage) => [stage, { stage, count: 0, value: 0, weighted: 0 }]));
  const rows: ActionRow[] = [];
  for (const deal of deals) {
    const stage = selectValue(deal, stageField) ?? "—";
    if (CLOSED_VALUE.test(stage) || WON_VALUE.test(stage)) continue;
    const amount = moneyOf(deal, amountField) ?? 0;
    const rawProbability = probabilityField ? numericValue(fieldsOf(deal)[probabilityField.key]) : null;
    const index = options.indexOf(stage);
    const probability = rawProbability !== null
      ? (rawProbability > 1 ? rawProbability / 100 : rawProbability)
      : index >= 0 ? (index + 1) / (options.length + 1) : 0;
    const weighted = amount * Math.min(1, Math.max(0, probability));
    const bucket = stages.get(stage) ?? { stage, count: 0, value: 0, weighted: 0 };
    bucket.count += 1;
    bucket.value += amount;
    bucket.weighted += weighted;
    stages.set(stage, bucket);
    rows.push({ id: deal.id, kind: deal.kind, title: deal.title, chip: `${format(weighted)} · ${stage}`, weight: weighted });
  }
  const list = [...stages.values()];
  return {
    stages: list,
    total: list.reduce((sum, s) => sum + s.value, 0),
    weighted: list.reduce((sum, s) => sum + s.weighted, 0),
    deals: rows.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
  };
}

/**
 * Zones where demand outruns supply. Demand is a numeric field on the zone
 * (`demand`, `searches`, `requests`…); supply is the zone's own supplier
 * count field when it has one, else the suppliers that point at it. Ranked
 * by demand per supplier, so a zone with demand and none at all leads.
 */
export function underSuppliedZones(
  zones: readonly RecordNodeLike[],
  zoneType: Pick<RecordTypeDefinition, "key" | "fields"> | null,
  suppliers: readonly RecordNodeLike[],
  supplierType: Pick<RecordTypeDefinition, "key" | "fields"> | null,
): ActionRow[] | null {
  if (!zoneType) return null;
  const demandField = findField(zoneType, /(demand|searches|requests|buyers|bookings)/, ["number", "money"]);
  if (!demandField) return null;
  const supplyField = findField(zoneType, /(supplier|supply|providers|hosts)/, ["number"]);
  const links = supplierType ? relationFieldsTo(supplierType, zoneType.key) : [];
  return zones
    .map((zone) => {
      const demand = numericValue(fieldsOf(zone)[demandField.key]) ?? 0;
      let supply = supplyField ? numericValue(fieldsOf(zone)[supplyField.key]) : null;
      if (supply === null) {
        supply = suppliers.filter((s) => links.some((field) => relationIds(fieldsOf(s)[field.key]).includes(zone.id))).length;
      }
      return { zone, demand, supply, ratio: demand / Math.max(supply, 0.5) };
    })
    .filter((row) => row.demand > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .map(({ zone, demand, supply }) => ({
      id: zone.id,
      kind: zone.kind,
      title: zone.title,
      chip: `${demand} demand · ${supply} supply`,
      tone: supply === 0 ? ("danger" as const) : ("warning" as const),
    }));
}

/** Open incidents (not in a closed stage or status), newest first. */
export function openIncidents(
  incidents: readonly RecordNodeLike[],
  type: Pick<RecordTypeDefinition, "fields" | "stage_field"> | null,
): ActionRow[] | null {
  if (!type) return null;
  const stage = type.stage_field ? type.fields.find((f) => f.key === type.stage_field) ?? null : null;
  const severity = findField(type, /^(severity|priority|urgency)$/, ["select"]);
  return incidents
    .filter((incident) => !CLOSED_VALUE.test(selectValue(incident, stage) ?? "") && incident.status !== "done" && incident.status !== "archived")
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .map((incident) => {
      const sev = selectValue(incident, severity);
      return { id: incident.id, kind: incident.kind, title: incident.title, chip: sev ?? selectValue(incident, stage) ?? "open", tone: sev && /high|critical|urgent|sev1|p0|p1/i.test(sev) ? ("danger" as const) : ("default" as const) };
    });
}

/** What the "What's being built" block lists: knowledge and work, not records. */
const BUILDING_KINDS = new Set(["task", "bug", "decision", "adr", "doc", "meeting", "goal"]);

export interface BuildingNow<T> {
  /** Most recently touched first. */
  items: T[];
  /** Touched in the last seven days. */
  changedThisWeek: number;
  /** Tasks and bugs done in the last seven days. */
  shippedThisWeek: number;
}

/**
 * The compact knowledge-activity block at the bottom of the business
 * overview: the latest work and knowledge, with two counts. Records are
 * left out — they are the business, shown above.
 */
export function buildingNow<T extends { kind: string; status: string | null; updated_at: string }>(
  nodes: readonly T[],
  now: Date,
  limit = 6,
): BuildingNow<T> {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const knowledge = nodes.filter((node) => BUILDING_KINDS.has(node.kind));
  const recent = knowledge.filter((node) => Date.parse(node.updated_at) >= weekAgo);
  return {
    items: [...knowledge].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit),
    changedThisWeek: recent.length,
    shippedThisWeek: recent.filter((node) => (node.kind === "task" || node.kind === "bug") && node.status === "done").length,
  };
}

export interface SegmentCount {
  segment: string;
  count: number;
}

const SEGMENT_KEY = /^(segment|audience|side|persona|customer_type|user_type)$/;
const SEGMENT_TYPE = /^(segment|audience|persona|cohort)s?$/;

/**
 * Requests grouped by segment. A segment-like select (`segment` in b2b,
 * `side` in a marketplace) wins; otherwise a relation to a segment-like
 * record type (b2c requests point at segment nodes), where a request counts
 * once under each segment it names and `titleOf` turns ids into names.
 * Null when the request type has neither.
 */
export function requestsBySegment(
  requests: readonly RecordNodeLike[],
  type: Pick<RecordTypeDefinition, "fields" | "stage_field"> | null,
  titleOf: (id: string) => string | undefined = () => undefined,
): SegmentCount[] | null {
  if (!type) return null;
  const select = findField(type, SEGMENT_KEY, ["select", "text"]);
  const relation = select ? null : type.fields.find((field) => field.type === "relation" && SEGMENT_TYPE.test(field.target ?? "")) ?? null;
  if (!select && !relation) return null;
  const counts = new Map<string, number>();
  const add = (segment: string) => counts.set(segment, (counts.get(segment) ?? 0) + 1);
  for (const request of requests) {
    if (select) {
      add(selectValue(request, select) ?? "Unspecified");
      continue;
    }
    const ids = relationIds(fieldsOf(request)[relation!.key]);
    if (ids.length === 0) add("Unspecified");
    for (const id of new Set(ids)) add(titleOf(id) ?? "Unknown segment");
  }
  return [...counts.entries()].map(([segment, count]) => ({ segment, count })).sort((a, b) => b.count - a.count);
}
