/**
 * The business settings screens' pure parts: the model list, the record type
 * draft (what the editor sends is what the contract accepts), the ingest
 * examples (each body passes the contract's own validation) and the sidebar's
 * choice of business views.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_MODELS, type RecordType } from "@bcontext-dev/contract/business/record-types";
import { BusinessEventInputSchema } from "@bcontext-dev/contract/business/events";
import { INGEST_KEY_PREFIX, RecordBatchSchema } from "@bcontext-dev/contract/business/ingest";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import { BUSINESS_MODEL_OPTIONS, DEFAULT_BUSINESS_MODEL } from "./models";
import { draftFromType, emptyField, emptyType, inputFromDraft, labelFromKey, patchFromDraft } from "./record-type-draft";
import { ingestExamples } from "./ingest-examples";
import { businessNavViews, isBusinessView } from "./nav";
import { businessPaths, readBusinessSettings, readRecordTypes } from "./endpoints";

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
  it("send bodies the contract accepts, to the real paths, with a placeholder key", () => {
    const examples = ingestExamples({ origin: "https://bctx.example/", slug: "acme" });
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(example.command).toContain(`Bearer ${INGEST_KEY_PREFIX}…`);
      expect(example.command).toContain("https://bctx.example/api/workspaces/acme/");
      expect(example.command).not.toContain("//api");
    }
    expect(BusinessEventInputSchema.safeParse(examples[0]!.body).success).toBe(true);
    expect(BusinessEventInputSchema.safeParse(examples[1]!.body).success).toBe(true);
    expect(RecordBatchSchema.safeParse(examples[2]!.body).success).toBe(true);
    expect(ingestExamples({ origin: "o", slug: "acme", key: "bctx_ingest_abc" })[0]!.command).toContain("bctx_ingest_abc");
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
  });

  it("shows nothing for a product workspace", () => {
    const views = [view("pipeline", ["deal"]), view("tasks", ["task"])];
    expect(businessNavViews(views, "product")).toEqual([]);
    expect(businessNavViews(views, "b2b").map((v) => v.id)).toEqual(["pipeline"]);
  });
});
