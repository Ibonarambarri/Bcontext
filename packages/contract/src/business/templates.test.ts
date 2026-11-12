import { describe, expect, it } from "vitest";
import { RecordTypeInputSchema } from "./record-types.js";
import { isCoreKind } from "../types.js";
import {
  BUSINESS_TEMPLATES,
  businessTemplateFor,
  planBusinessTemplate,
  templateViewMarker,
  templateViewPresentation,
} from "./templates.js";
import { normalizeViewPresentation, normalizeViewQuery, parseFieldRef } from "../views/schema.js";
import { businessLayoutIssues } from "../views/business.js";
import { recordViewFieldRefs } from "../views/fields.js";

describe("business templates", () => {
  it("product has no template", () => {
    expect(businessTemplateFor("product")).toBeNull();
    expect(planBusinessTemplate("product", { record_type_keys: [], views: [] }).create_record_types).toEqual([]);
  });

  for (const template of Object.values(BUSINESS_TEMPLATES)) {
    describe(template.model, () => {
      it("every record type is one the API would accept", () => {
        for (const type of template.record_types) {
          const { dataset, ...input } = type;
          const parsed = RecordTypeInputSchema.safeParse({ ...input, ...(type.storage === "dataset" ? { dataset_node_id: "placeholder" } : {}) });
          expect(parsed.success, `${type.key}: ${parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; ")}`).toBe(true);
          expect(isCoreKind(type.key)).toBe(false);
          expect(Boolean(dataset)).toBe(type.storage === "dataset");
          // Relations point inside the template, so applying it alone is enough.
          for (const field of type.fields) {
            if (field.type === "relation") expect(template.record_types.some((t) => t.key === field.target && t.storage === "node")).toBe(true);
          }
        }
      });

      it("every view parses and only names fields its record types declare", () => {
        const keys = new Set<string>();
        for (const view of template.views) {
          expect(keys.has(view.key)).toBe(false);
          keys.add(view.key);
          const query = normalizeViewQuery(view.query);
          const presentation = normalizeViewPresentation(templateViewPresentation(template.model, view));
          expect(businessLayoutIssues(presentation)).toEqual([]);
          expect(presentation.layout.template).toBe(templateViewMarker(template.model, view.key));
          const typeKeys = query.dataset_type ? [query.dataset_type] : query.kinds;
          const types = template.record_types.filter((type) => typeKeys.includes(type.key));
          expect(types).toHaveLength(typeKeys.length);
          for (const type of types) expect(type.storage).toBe(query.dataset_type ? "dataset" : "node");
          const declared = new Set(types.flatMap((type) => type.fields.map((field) => field.key)));
          for (const ref of [...recordViewFieldRefs(presentation), ...query.field_filters.map((f) => f.field)]) {
            expect(declared.has(ref), `${view.key} names field:${ref}`).toBe(true);
          }
          if (presentation.renderer === "board") expect(parseFieldRef(presentation.group_by)).not.toBeNull();
        }
      });
    });
  }

  it("b2b has the pipeline with deal stages lead → won/lost", () => {
    const deal = BUSINESS_TEMPLATES.b2b.record_types.find((t) => t.key === "deal")!;
    expect(deal.fields.find((f) => f.key === "stage")!.options).toEqual(["lead", "demo", "proposal", "negotiation", "won", "lost"]);
    expect(BUSINESS_TEMPLATES.b2b.views.map((v) => v.name)).toEqual(["Pipeline", "Accounts", "Renewals", "Requests", "Metrics", "Expenses"]);
  });

  it("marketplace has dataset-backed suppliers and buyers and a YoY metrics view", () => {
    const template = BUSINESS_TEMPLATES.marketplace;
    expect(template.record_types.filter((t) => t.storage === "dataset").map((t) => t.key)).toEqual(["supplier", "buyer"]);
    const metrics = template.views.find((v) => v.key === "metrics")!;
    expect(JSON.stringify(metrics.presentation.layout)).toContain("\"yoy\":true");
  });
});

describe("planBusinessTemplate", () => {
  it("creates everything on an empty workspace", () => {
    const plan = planBusinessTemplate("b2b", { record_type_keys: [], views: [] });
    expect(plan.create_record_types.map((t) => t.key)).toEqual(["account", "contact", "deal", "request"]);
    expect(plan.create_views).toHaveLength(6);
    expect(plan.skipped).toEqual([]);
  });

  it("is additive and idempotent: existing keys, markers and slugs are skipped", () => {
    const plan = planBusinessTemplate("b2b", {
      record_type_keys: ["account", "deal"],
      views: [
        { slug: "my-pipeline", presentation: { layout: { template: "b2b:pipeline" } } },
        { slug: "accounts", presentation: { layout: {} } },
      ],
    });
    expect(plan.create_record_types.map((t) => t.key)).toEqual(["contact", "request"]);
    expect(plan.create_views.map((v) => v.key)).toEqual(["renewals", "requests", "metrics", "expenses"]);
    expect(plan.skipped.map((s) => `${s.what}:${s.key}`)).toEqual(["record_type:account", "record_type:deal", "view:pipeline", "view:accounts"]);

    const again = planBusinessTemplate("b2b", {
      record_type_keys: ["account", "contact", "deal", "request"],
      views: BUSINESS_TEMPLATES.b2b.views.map((view) => ({ slug: view.key, presentation: templateViewPresentation("b2b", view) as { layout: Record<string, unknown> } })),
    });
    expect(again.create_record_types).toEqual([]);
    expect(again.create_views).toEqual([]);
  });
});
