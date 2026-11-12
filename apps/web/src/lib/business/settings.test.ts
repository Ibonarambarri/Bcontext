/**
 * The business settings screens' pure parts: the model list, the record type
 * draft (what the editor sends is what the contract accepts), the ingest
 * examples (each body passes the contract's own validation) and the sidebar's
 * choice of business views.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_MODELS, validateRecordFields, type RecordType } from "@bcontext-dev/contract/business/record-types";
import { BUSINESS_TEMPLATES } from "@bcontext-dev/contract/business/templates";
import { BusinessEventInputSchema } from "@bcontext-dev/contract/business/events";
import { INGEST_KEY_PREFIX, RecordBatchSchema } from "@bcontext-dev/contract/business/ingest";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import { BUSINESS_MODEL_OPTIONS, DEFAULT_BUSINESS_MODEL } from "./models";
import { draftFromType, emptyField, emptyType, inputFromDraft, labelFromKey, patchFromDraft } from "./record-type-draft";
import { ingestExamples } from "./ingest-examples";
import { businessNavViews, isBusinessView } from "./nav";
import { businessPaths, readBusinessSettings, readRecordTypes } from "./endpoints";
import { describeTemplateResult } from "./client";
import type { BusinessTemplateResult } from "@bcontext-dev/contract/business/templates";

describe("business models", () => {
  it("offers every model the contract knows, product by default", () => {
    expect(BUSINESS_MODEL_OPTIONS.map((o) => o.id).sort()).toEqual([...BUSINESS_MODELS].sort());
    expect(DEFAULT_BUSINESS_MODEL).toBe("product");
  });
});

describe("record type draft", () => {
  it("builds a create body the contract accepts", () => {
    const draft = {
      ...emptyType(),
      key: "account",
      label: "Account",
      stageField: "stage",
      fields: [
        { ...emptyField(), key: "stage", label: "Stage", type: "select" as const, optionsText: "trial, customer , churned" },
        { ...emptyField(), key: "owner", label: "", type: "relation" as const, target: "contact", multiple: true },
      ],
    };
    const result = inputFromDraft(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fields).toEqual([
      { key: "stage", label: "Stage", type: "select", options: ["trial", "customer", "churned"] },
      { key: "owner", label: "owner", type: "relation", target: "contact", multiple: true },
    ]);
  });

  it("shows the contract's own reasons before saving", () => {
    const bad = inputFromDraft({ ...emptyType(), key: "task", label: "Task", fields: [{ ...emptyField(), key: "s", type: "select" }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join(" ")).toContain("core kind");
    expect(bad.errors.join(" ")).toContain("needs options");
  });

  it("patches everything but identity, and re-checks the stage field", () => {
    const type: RecordType = {
      id: "t",
      workspace_id: "w",
      position: 0,
      created_at: "",
      updated_at: "",
      key: "deal",
      label: "Deal",
      storage: "node",
      stage_field: "stage",
      fields: [{ key: "stage", label: "Stage", type: "select", options: ["lead", "won"] }],
    };
    const draft = draftFromType(type);
    expect(draft.fields[0]).toMatchObject({ optionsText: "lead, won", isNew: false });
    const ok = patchFromDraft({ ...draft, label: "Opportunity" });
    expect(ok.ok && ok.value).toMatchObject({ label: "Opportunity", stage_field: "stage" });
    expect(ok.ok && "key" in ok.value).toBe(false);
    const broken = patchFromDraft({ ...draft, fields: [] });
    expect(broken.ok).toBe(false);
  });

  it("labels a key", () => {
    expect(labelFromKey("renewal_date")).toBe("Renewal date");
  });
});

describe("ingest examples", () => {
  const typesOf = (model: "b2b" | "b2c" | "marketplace") => BUSINESS_TEMPLATES[model].record_types;

  it("send bodies the contract accepts, to the real paths, with a placeholder key", () => {
    for (const model of BUSINESS_MODELS) {
      const examples = ingestExamples({ origin: "https://bctx.example/", slug: "acme", model });
      expect(examples, model).toHaveLength(3);
      for (const example of examples) {
        expect(example.command).toContain(`Bearer ${INGEST_KEY_PREFIX}…`);
        expect(example.command).toContain("https://bctx.example/api/workspaces/acme/");
        expect(example.command).not.toContain("//api");
      }
      expect(BusinessEventInputSchema.safeParse(examples[0]!.body).success, model).toBe(true);
      expect(BusinessEventInputSchema.safeParse(examples[1]!.body).success, model).toBe(true);
      expect(RecordBatchSchema.safeParse(examples[2]!.body).success, model).toBe(true);
    }
    expect(ingestExamples({ origin: "o", slug: "acme", key: "bctx_ingest_abc" })[0]!.command).toContain("bctx_ingest_abc");
  });

  it("match the business model: subscriptions for b2b and b2c, bookings for a marketplace", () => {
    const first = (model: (typeof BUSINESS_MODELS)[number]) => ingestExamples({ origin: "o", slug: "acme", model })[0]!.body as Record<string, any>;
    expect(first("b2b")).toMatchObject({ type: "subscription.started", subject_type: "account" });
    expect(first("product")).toMatchObject({ type: "subscription.started" });
    expect(first("b2c")).toMatchObject({ type: "subscription.started", subject_type: "customer" });
    const booking = first("marketplace");
    expect(booking.type).toBe("booking.created");
    expect(booking.properties).toMatchObject({ booking_id: expect.any(String), supplier_id: expect.any(String), fee: expect.any(Number) });
    expect(booking.amount).toBeGreaterThan(booking.properties.fee);
    // Without a model (settings not read) the b2b set is still a correct call.
    expect(ingestExamples({ origin: "o", slug: "acme" })[0]!.body).toMatchObject({ type: "subscription.started" });
  });

  it("write records of the model's own type, with fields its template accepts", () => {
    for (const [model, type] of [["b2b", "account"], ["b2c", "customer"], ["marketplace", "supplier"]] as const) {
      const example = ingestExamples({ origin: "o", slug: "acme", model })[2]!;
      expect(example.record_type).toBe(type);
      expect(example.command).toContain(`/records/${type}`);
      const def = typesOf(model).find((candidate) => candidate.key === type)!;
      for (const record of (example.body as { records: Array<{ fields: unknown }> }).records) {
        const result = validateRecordFields(def, record.fields, "create");
        expect(result.ok, `${model}: ${result.ok ? "" : result.message}`).toBe(true);
      }
    }
  });
});

describe("record type draft", () => {
  it("keeps a field's total through an edit, and drops it on a field that cannot total", () => {
    const type = { key: "supplier", label: "Supplier", storage: "node", fields: [{ key: "rating", label: "Rating", type: "number", total: "average" }] } as unknown as RecordType;
    const draft = draftFromType(type);
    expect(draft.fields[0]!.total).toBe("average");
    const patch = patchFromDraft(draft);
    expect(patch.ok && patch.value.fields?.[0]).toMatchObject({ key: "rating", total: "average" });
    const text = patchFromDraft({ ...draft, fields: [{ ...draft.fields[0]!, type: "text", total: "sum" }] });
    expect(text.ok && text.value.fields?.[0]).not.toHaveProperty("total");
  });
});

describe("endpoints", () => {
  it("are all under the workspace's own routes", () => {
    for (const path of [
      businessPaths.settings("acme"),
      businessPaths.metricsSummary("acme"),
      businessPaths.recordType("acme", "deal"),
      businessPaths.ingestKey("acme", "k1"),
      businessPaths.records("acme", "account", 10),
      businessPaths.events("acme", { subjectType: "account", subjectId: "cus 1" }),
    ]) {
      expect(path.startsWith("/api/workspaces/acme/")).toBe(true);
    }
    expect(businessPaths.events("acme", { subjectType: "account", subjectId: "cus 1" })).toBe("/api/workspaces/acme/events?subject_type=account&subject_id=cus+1");
  });

  it("read the route's shapes defensively", () => {
    expect(readBusinessSettings({ business_model: "b2b", currency: "USD" })).toEqual({ business_model: "b2b", currency: "USD" });
    expect(readBusinessSettings(null)).toBeNull();
    expect(readRecordTypes({ record_types: [{ key: "a" }] })).toHaveLength(1);
    expect(readRecordTypes({})).toEqual([]);
  });
});

describe("business views in the sidebar", () => {
  const view = (id: string, kinds: string[], extra: Partial<SavedView> = {}) =>
    ({
      id,
      slug: id,
      name: id,
      system_key: null,
      created_at: `2026-01-0${id.length}`,
      query: { kinds } as SavedView["query"],
      presentation: { renderer: "board" } as SavedView["presentation"],
      ...extra,
    }) as SavedView;

  it("picks views over record types, business system views and metrics", () => {
    expect(isBusinessView(view("pipeline", ["deal"]))).toBe(true);
    expect(isBusinessView(view("tasks", ["task", "bug"]))).toBe(false);
    expect(isBusinessView(view("mixed", ["account", "task"]))).toBe(false);
    expect(isBusinessView(view("all", []))).toBe(false);
    expect(isBusinessView(view("m", [], { presentation: { renderer: "metrics" } as unknown as SavedView["presentation"] }))).toBe(true);
    expect(isBusinessView(view("s", [], { system_key: "business:renewals" }))).toBe(true);
    // The marketplace template's Supply vs demand and Suppliers views.
    expect(isBusinessView(view("h", [], { presentation: { renderer: "heatmap" } as unknown as SavedView["presentation"] }))).toBe(true);
    expect(isBusinessView(view("d", [], { query: { kinds: [], dataset_type: "supplier" } as unknown as SavedView["query"] }))).toBe(true);
    expect(isBusinessView(view("t", [], { presentation: { renderer: "table", layout: { template: "b2c:customers" } } as unknown as SavedView["presentation"] }))).toBe(true);
  });

  it("shows nothing for a product workspace", () => {
    const views = [view("pipeline", ["deal"]), view("tasks", ["task"])];
    expect(businessNavViews(views, "product")).toEqual([]);
    expect(businessNavViews(views, "b2b").map((v) => v.id)).toEqual(["pipeline"]);
  });
});

describe("describeTemplateResult", () => {
  const result = (over: Partial<BusinessTemplateResult>): BusinessTemplateResult => ({
    model: "b2b",
    created: { record_types: [], datasets: [], views: [] },
    skipped: [],
    ...over,
  });

  it("says what was added and ignores what already existed", () => {
    const out = describeTemplateResult("B2B", result({
      created: { record_types: ["account", "deal"], datasets: [], views: [{ key: "pipeline", id: "v1", name: "Pipeline" }] },
      skipped: [{ what: "record_type", key: "contact", reason: "a record type with this key exists" }],
    }));
    expect(out).toEqual({ ok: true, text: "Applied the B2B template: 2 record types and 1 view added. Nothing that was already here changed." });
  });

  it("reports a view the API refused instead of claiming success", () => {
    const out = describeTemplateResult("B2B", result({
      created: { record_types: ["account"], datasets: [], views: [] },
      skipped: [{ what: "view", key: "pipeline", reason: "violates check constraint", failed: true }],
    }));
    expect(out.ok).toBe(false);
    expect(out.text).toContain("1 could not be added: view pipeline (violates check constraint)");
  });
});
