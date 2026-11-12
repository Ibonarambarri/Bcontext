/**
 * Business templates — the record types and views a workspace starts with
 * for its business model (b2b, b2c, marketplace). `product` has none: it is
 * today's workspace.
 *
 * Who uses it: the API's `applyBusinessTemplate` (REST
 * `POST /api/workspaces/:ws/business/apply-template`, which the web's
 * Business settings and workspace creation call;
 * `admin_write(op=apply_business_template)`; and `POST /api/workspaces` with
 * a business model) asks `planBusinessTemplate` what is missing and creates
 * exactly that. `ApplyBusinessTemplateBody` / `BusinessTemplateResult` are
 * that route's request and response.
 *
 * The rule that makes it safe to run twice, or after a person has edited
 * things: templates are DEFAULTS, applying is ADDITIVE. A record type whose
 * key exists is skipped — even if its fields differ, it is the person's now —
 * and a view is skipped when one carries its template marker
 * (`presentation.layout.template`) or its slug. Nothing is ever deleted,
 * renamed or overwritten. Labels (`supplier` → "Instructors") are the
 * expected edit and survive every re-apply because the key is the identity.
 *
 * Must not break: every record type here parses with
 * `RecordTypeInputSchema` (dataset-backed ones with a placeholder dataset id)
 * and every view with the view schemas and `businessLayoutIssues` —
 * `templates.test.ts` checks both, so a template can't ship that its own
 * apply would refuse.
 */
import { z } from "zod";
import { BUSINESS_MODELS, type RecordFieldDef, type RecordStorage, type BusinessModel } from "./record-types.js";
import type { ViewPresentation, ViewQuery } from "../views/schema.js";

export interface TemplateRecordType {
  key: string;
  label: string;
  label_plural: string;
  description: string;
  storage: RecordStorage;
  fields: RecordFieldDef[];
  stage_field?: string;
  /** storage=dataset: the `data` node the template creates to hold the rows. */
  dataset?: { title: string; description: string };
}

export interface TemplateView {
  /** Stable within the model; the marker is `<model>:<key>`. */
  key: string;
  name: string;
  description: string;
  query: Partial<ViewQuery> & { schema_version: 1 };
  presentation: Partial<ViewPresentation> & { schema_version: 1; renderer: ViewPresentation["renderer"] };
}

export interface BusinessTemplate {
  model: BusinessModel;
  record_types: TemplateRecordType[];
  views: TemplateView[];
}

/** The marker a template view carries in `presentation.layout.template`. */
export function templateViewMarker(model: BusinessModel, key: string): string {
  return `${model}:${key}`;
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

const REQUEST_STATUSES = ["requested", "planned", "in_progress", "shipped", "declined"];
const INCIDENT_STATUSES = ["open", "investigating", "mitigated", "resolved"];
const SEVERITIES = ["low", "medium", "high", "critical"];

/**
 * `audience` is the select a request is grouped by on the business overview
 * (the web's `requestsBySegment` looks for `segment`/`side`/`audience`…): a
 * b2b request is grouped by company size, a marketplace one by the side of
 * the market that asked. b2c requests point at segment nodes instead.
 */
function request(target: string, relationLabel: string, audience?: RecordFieldDef): TemplateRecordType {
  return {
    key: "request",
    label: "Request",
    label_plural: "Requests",
    description: "A feature request or complaint from customers, ranked by how much it weighs.",
    storage: "node",
    stage_field: "status",
    fields: [
      { key: "status", label: "Status", type: "select", options: REQUEST_STATUSES, required: true, description: "requested → planned → in_progress → shipped (or declined)." },
      { key: "weight", label: "Weight", type: "number", description: "How much it matters: requesters, MRR behind it, or a score. Higher ranks first." },
      { key: target === "account" ? "accounts" : "segments", label: relationLabel, type: "relation", target, multiple: true, description: `Which ${relationLabel.toLowerCase()} asked for it.` },
      ...(audience ? [audience] : []),
      { key: "source", label: "Source", type: "select", options: ["sales", "support", "interview", "agent", "other"] },
    ],
  };
}

function incident(extra: RecordFieldDef[] = []): TemplateRecordType {
  return {
    key: "incident",
    label: "Incident",
    label_plural: "Incidents",
    description: "Something that went wrong for customers: an outage, a bad experience, a complaint that needs follow-up.",
    storage: "node",
    stage_field: "status",
    fields: [
      { key: "status", label: "Status", type: "select", options: INCIDENT_STATUSES, required: true },
      { key: "severity", label: "Severity", type: "select", options: SEVERITIES, required: true },
      { key: "occurred_on", label: "Occurred on", type: "date" },
      { key: "resolved_on", label: "Resolved on", type: "date" },
      ...extra,
    ],
  };
}

function segment(): TemplateRecordType {
  return {
    key: "segment",
    label: "Segment",
    label_plural: "Segments",
    description: "A group of customers you reason about together (plan, country, use case).",
    storage: "node",
    fields: [
      { key: "definition", label: "Definition", type: "text", description: "Who is in it, as a rule a person can check." },
      { key: "size", label: "Size", type: "number", description: "How many customers, last counted." },
      { key: "priority", label: "Priority", type: "select", options: ["core", "growth", "explore", "deprioritised"] },
    ],
  };
}

const requestsBoard = (relationField: string): TemplateView => ({
  key: "requests",
  name: "Requests",
  description: "Feature requests by status, heaviest first.",
  query: { schema_version: 1, kinds: ["request"] },
  presentation: {
    schema_version: 1,
    renderer: "board",
    group_by: "field:status",
    sort_by: [{ field: "field:weight", direction: "desc" }],
    columns: ["title", "field:weight", `field:${relationField}`],
    layout: { board: { total_field: "weight" } },
  },
});

const expensesView = (kpis: string[]): TemplateView => ({
  key: "expenses",
  name: "Expenses",
  description: "Where the money goes: expense KPIs and spend by month, from expense.recorded events.",
  query: { schema_version: 1 },
  presentation: {
    schema_version: 1,
    renderer: "metrics",
    layout: {
      metrics: {
        kpis,
        compare: "previous",
        charts: [
          {
            title: "Expenses by month",
            type: "bar",
            unit: "money",
            aggregate: {
              source: { from: "events", types: ["expense.recorded"] },
              x: { key: "occurred_at", bucket: "month" },
              measures: [{ as: "spend", op: "sum", key: "amount" }],
            },
            yoy: false,
          },
        ],
      },
    },
  },
});

/* -------------------------------------------------------------------------- */
/*  b2b                                                                       */
/* -------------------------------------------------------------------------- */

const B2B: BusinessTemplate = {
  model: "b2b",
  record_types: [
    {
      key: "account",
      label: "Account",
      label_plural: "Accounts",
      description: "A company that pays (or might): plan, MRR, health and renewal.",
      storage: "node",
      stage_field: "status",
      fields: [
        { key: "status", label: "Status", type: "select", options: ["trial", "active", "at_risk", "churned"], required: true },
        { key: "plan", label: "Plan", type: "text" },
        { key: "mrr", label: "MRR", type: "money", description: "Monthly recurring revenue today (from billing when the app pushes it)." },
        { key: "health", label: "Health", type: "select", options: ["green", "yellow", "red"] },
        { key: "renewal_date", label: "Renewal", type: "date" },
        { key: "owner", label: "Owner", type: "person", description: "Who on the team owns the relationship." },
        { key: "seats", label: "Seats", type: "number" },
        { key: "website", label: "Website", type: "url" },
      ],
    },
    {
      key: "contact",
      label: "Contact",
      label_plural: "Contacts",
      description: "A person at an account.",
      storage: "node",
      fields: [
        { key: "account", label: "Account", type: "relation", target: "account" },
        { key: "role", label: "Role", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "decision_maker", label: "Decision maker", type: "boolean" },
      ],
    },
    {
      key: "deal",
      label: "Deal",
      label_plural: "Deals",
      description: "A sale in progress, from first call to won or lost.",
      storage: "node",
      stage_field: "stage",
      fields: [
        { key: "stage", label: "Stage", type: "select", options: ["lead", "demo", "proposal", "negotiation", "won", "lost"], required: true },
        { key: "amount", label: "Amount", type: "money", description: "Expected MRR of the deal." },
        { key: "probability", label: "Probability", type: "number", description: "0-100, the owner's honest estimate." },
        { key: "account", label: "Account", type: "relation", target: "account" },
        { key: "close_date", label: "Close date", type: "date" },
        { key: "owner", label: "Owner", type: "person" },
      ],
    },
    request("account", "Accounts", { key: "segment", label: "Segment", type: "select", options: ["smb", "mid_market", "enterprise"] }),
  ],
  views: [
    {
      key: "pipeline",
      name: "Pipeline",
      description: "Deals by stage, with the count and amount of each.",
      query: { schema_version: 1, kinds: ["deal"] },
      presentation: {
        schema_version: 1,
        renderer: "board",
        group_by: "field:stage",
        sort_by: [{ field: "field:amount", direction: "desc" }],
        columns: ["title", "field:amount", "field:account", "field:close_date"],
        layout: { board: { total_field: "amount", total_suffix: "/mo" } },
      },
    },
    {
      key: "accounts",
      name: "Accounts",
      description: "Every account with plan, MRR, health and renewal.",
      query: { schema_version: 1, kinds: ["account"] },
      presentation: {
        schema_version: 1,
        renderer: "table",
        sort_by: [{ field: "field:mrr", direction: "desc" }],
        columns: ["title", "field:status", "field:plan", "field:mrr", "field:health", "field:renewal_date", "field:owner"],
      },
    },
    {
      key: "renewals",
      name: "Renewals",
      description: "Accounts with a renewal date, soonest first.",
      query: { schema_version: 1, kinds: ["account"], field_filters: [{ field: "renewal_date", op: "empty", value: false }] },
      presentation: {
        schema_version: 1,
        renderer: "table",
        sort_by: [{ field: "field:renewal_date", direction: "asc" }],
        columns: ["title", "field:renewal_date", "field:mrr", "field:health", "field:owner"],
      },
    },
    requestsBoard("accounts"),
    {
      key: "metrics",
      name: "Metrics",
      description: "MRR, growth, churn and runway from the billing events the app pushes.",
      query: { schema_version: 1 },
      presentation: {
        schema_version: 1,
        renderer: "metrics",
        layout: {
          metrics: {
            compare: "previous",
            charts: [
              { title: "MRR", type: "line", unit: "money", kpis: ["mrr"], yoy: false },
              { title: "New vs churned MRR", type: "bar", unit: "money", kpis: ["new_mrr", "churned_mrr"], yoy: false },
            ],
          },
        },
      },
    },
    expensesView(["expenses", "net", "burn", "runway_months"]),
  ],
};

/* -------------------------------------------------------------------------- */
/*  b2c                                                                       */
/* -------------------------------------------------------------------------- */

const B2C: BusinessTemplate = {
  model: "b2c",
  record_types: [
    segment(),
    request("segment", "Segments"),
    incident([{ key: "segments", label: "Segments", type: "relation", target: "segment", multiple: true }]),
    {
      key: "customer",
      label: "Customer",
      label_plural: "Customers",
      description: "A paying person. Rows of a dataset keyed by the app's customer id: too many to be nodes.",
      storage: "dataset",
      dataset: { title: "Customers", description: "One row per customer, keyed by the app's customer id. Pushed by the ingest API." },
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "plan", label: "Plan", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["trialing", "active", "past_due", "churned"] },
        { key: "mrr", label: "MRR", type: "number", description: "Monthly amount in the reporting currency." },
        { key: "signup_date", label: "Signed up", type: "date" },
        { key: "country", label: "Country", type: "text" },
      ],
    },
  ],
  views: [
    {
      key: "customers",
      name: "Customers",
      description: "Customer rows from the app, newest signups first.",
      query: { schema_version: 1, dataset_type: "customer" },
      presentation: {
        schema_version: 1,
        renderer: "table",
        sort_by: [{ field: "field:signup_date", direction: "desc" }],
        columns: ["field:name", "field:email", "field:plan", "field:status", "field:mrr", "field:signup_date", "field:country"],
      },
    },
    requestsBoard("segments"),
    {
      key: "metrics",
      name: "Metrics",
      description: "MRR, growth, churn and runway from the billing events the app pushes.",
      query: { schema_version: 1 },
      presentation: {
        schema_version: 1,
        renderer: "metrics",
        layout: {
          metrics: {
            compare: "previous",
            charts: [
              { title: "MRR", type: "line", unit: "money", kpis: ["mrr"], yoy: false },
              { title: "Customers", type: "line", unit: "count", kpis: ["active_customers", "new_customers"], yoy: false },
            ],
          },
        },
      },
    },
    expensesView(["expenses", "net", "burn", "runway_months"]),
  ],
};

/* -------------------------------------------------------------------------- */
/*  marketplace                                                               */
/* -------------------------------------------------------------------------- */

const MARKETPLACE: BusinessTemplate = {
  model: "marketplace",
  record_types: [
    segment(),
    {
      key: "zone",
      label: "Zone",
      label_plural: "Zones",
      description: "Where supply meets demand: a city, a resort, a region.",
      storage: "node",
      fields: [
        { key: "zone_code", label: "Code", type: "text", description: "The value bookings carry in properties.zone." },
        { key: "region", label: "Region", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["launching", "live", "paused"] },
        // The overview ranks zones by demand per active supplier; an agent
        // (or the app) keeps both current.
        { key: "demand", label: "Demand", type: "number", description: "Recent demand in the zone: bookings or searches over the last 4 weeks." },
        { key: "active_suppliers", label: "Active suppliers", type: "number", description: "Suppliers with availability in the zone now." },
      ],
    },
    incident([{ key: "zone", label: "Zone", type: "relation", target: "zone" }]),
    request("segment", "Segments", { key: "side", label: "Side", type: "select", options: ["supplier", "buyer", "both"], description: "Which side of the market asked." }),
    {
      key: "supplier",
      label: "Supplier",
      label_plural: "Suppliers",
      description: "Who provides the service (rename to fit: instructors, hosts, drivers). Dataset rows keyed by the app's id.",
      storage: "dataset",
      dataset: { title: "Suppliers", description: "One row per supplier, keyed by the app's supplier id. Pushed by the ingest API." },
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "zone", label: "Zone", type: "text" },
        { key: "status", label: "Status", type: "select", options: ["onboarding", "active", "paused", "offboarded"] },
        { key: "rating", label: "Rating", type: "number" },
        { key: "joined_on", label: "Joined", type: "date" },
      ],
    },
    {
      key: "buyer",
      label: "Buyer",
      label_plural: "Buyers",
      description: "Who books (rename to fit: clients, guests, riders). Dataset rows keyed by the app's id.",
      storage: "dataset",
      dataset: { title: "Buyers", description: "One row per buyer, keyed by the app's buyer id. Pushed by the ingest API." },
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "zone", label: "Zone", type: "text" },
        { key: "first_booking_on", label: "First booking", type: "date" },
        { key: "bookings", label: "Bookings", type: "number" },
      ],
    },
  ],
  views: [
    {
      key: "metrics",
      name: "Marketplace metrics",
      description: "GMV, take, liquidity — each week against the same week last year.",
      query: { schema_version: 1 },
      presentation: {
        schema_version: 1,
        renderer: "metrics",
        layout: {
          metrics: {
            compare: "year_ago",
            charts: [
              {
                title: "GMV by week (vs last year)",
                type: "line",
                unit: "money",
                aggregate: {
                  source: { from: "events", types: ["booking.created"] },
                  x: { key: "occurred_at", bucket: "week" },
                  measures: [{ as: "gmv", op: "sum", key: "amount" }],
                },
                yoy: true,
              },
              {
                title: "Bookings by week (vs last year)",
                type: "bar",
                unit: "count",
                aggregate: {
                  source: { from: "events", types: ["booking.created"] },
                  x: { key: "occurred_at", bucket: "week" },
                  measures: [{ as: "bookings", op: "count" }],
                },
                yoy: true,
              },
            ],
          },
        },
      },
    },
    {
      key: "supply-demand",
      name: "Supply vs demand",
      description: "Bookings per active supplier, zone × week. Hot cells are where demand outruns supply.",
      query: { schema_version: 1 },
      presentation: {
        schema_version: 1,
        renderer: "heatmap",
        layout: {
          heatmap: {
            aggregate: {
              source: { from: "events", types: ["booking.created"] },
              x: { key: "occurred_at", bucket: "week" },
              y: { key: "zone" },
              measures: [
                { as: "bookings", op: "count" },
                { as: "suppliers", op: "count_distinct", key: "supplier_id" },
              ],
            },
            value: "bookings",
            second: "suppliers",
            value_label: "bookings",
            second_label: "suppliers",
            color_by: "ratio",
            high_is: "bad",
          },
        },
      },
    },
    {
      key: "suppliers",
      name: "Suppliers",
      description: "Supplier rows from the app, by zone.",
      query: { schema_version: 1, dataset_type: "supplier" },
      presentation: {
        schema_version: 1,
        renderer: "table",
        sort_by: [{ field: "field:zone", direction: "asc" }],
        columns: ["field:name", "field:zone", "field:status", "field:rating", "field:joined_on", "field:email"],
      },
    },
    {
      key: "incidents",
      name: "Incidents",
      description: "Open incidents by status, worst first.",
      query: { schema_version: 1, kinds: ["incident"] },
      presentation: {
        schema_version: 1,
        renderer: "board",
        group_by: "field:status",
        sort_by: [{ field: "field:severity", direction: "desc" }],
        columns: ["title", "field:severity", "field:zone", "field:occurred_on"],
      },
    },
    requestsBoard("segments"),
    expensesView(["expenses", "net"]),
  ],
};

export const BUSINESS_TEMPLATES: Record<Exclude<BusinessModel, "product">, BusinessTemplate> = {
  b2b: B2B,
  b2c: B2C,
  marketplace: MARKETPLACE,
};

export function businessTemplateFor(model: BusinessModel): BusinessTemplate | null {
  return model === "product" ? null : BUSINESS_TEMPLATES[model];
}

/* -------------------------------------------------------------------------- */
/*  Plan                                                                      */
/* -------------------------------------------------------------------------- */

export interface ExistingWorkspaceShape {
  record_type_keys: readonly string[];
  views: ReadonlyArray<{ slug: string; presentation: { layout?: Record<string, unknown> } }>;
}

export interface BusinessTemplatePlan {
  model: BusinessModel;
  create_record_types: TemplateRecordType[];
  create_views: TemplateView[];
  skipped: Array<{ what: "record_type" | "view"; key: string; reason: string }>;
}

/** The slug the views store gives a name (`views/store.ts`, `uniqueSlug` before its suffix). */
function slugOf(name: string): string {
  return name.trim().toLocaleLowerCase("en-US").normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140) || "view";
}

/**
 * What applying `model`'s template to a workspace would create: the record
 * types whose key is free and the views nobody has yet. Everything else is
 * listed in `skipped` with why, so a re-apply can say "nothing to do".
 */
export function planBusinessTemplate(model: BusinessModel, existing: ExistingWorkspaceShape): BusinessTemplatePlan {
  const template = businessTemplateFor(model);
  const plan: BusinessTemplatePlan = { model, create_record_types: [], create_views: [], skipped: [] };
  if (!template) return plan;
  const keys = new Set(existing.record_type_keys);
  for (const type of template.record_types) {
    if (keys.has(type.key)) plan.skipped.push({ what: "record_type", key: type.key, reason: "a record type with this key exists" });
    else plan.create_record_types.push(type);
  }
  const markers = new Set(existing.views.map((view) => view.presentation.layout?.template).filter((m): m is string => typeof m === "string"));
  const slugs = new Set(existing.views.map((view) => view.slug));
  for (const view of template.views) {
    if (markers.has(templateViewMarker(model, view.key))) plan.skipped.push({ what: "view", key: view.key, reason: "already applied" });
    else if (slugs.has(slugOf(view.name))) plan.skipped.push({ what: "view", key: view.key, reason: `a view named “${view.name}” exists` });
    else plan.create_views.push(view);
  }
  return plan;
}

/** A template view's presentation with its marker, ready for `createView`. */
export function templateViewPresentation(model: BusinessModel, view: TemplateView): TemplateView["presentation"] {
  return { ...view.presentation, layout: { ...(view.presentation.layout ?? {}), template: templateViewMarker(model, view.key) } };
}

/* -------------------------------------------------------------------------- */
/*  The apply-template route                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/workspaces/:ws/business/apply-template` body. Optional, and so
 * is the body itself: without a model the workspace's current one is
 * applied.
 */
export const ApplyBusinessTemplateBodySchema = z.object({
  business_model: z.enum(BUSINESS_MODELS).optional(),
}).strict();
export type ApplyBusinessTemplateBody = z.infer<typeof ApplyBusinessTemplateBodySchema>;

/**
 * What applying did: `201` when it created something, `200` when there was
 * nothing left to create (a re-apply). `GET` on the same path answers the
 * `BusinessTemplatePlan` without writing.
 */
export interface BusinessTemplateResult {
  model: BusinessModel;
  created: {
    record_types: string[];
    /** The `data` nodes behind dataset-backed types; `reused` when an earlier run made it. */
    datasets: Array<{ record_type: string; node_id: string; reused: boolean }>;
    views: Array<{ key: string; id: string; name: string }>;
  };
  skipped: BusinessTemplatePlan["skipped"];
}
