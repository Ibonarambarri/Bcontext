/**
 * The overview finds record types by role and fields by name
 * (`overview.ts`); the templates (`@bcontext-dev/contract/business/templates`)
 * decide those names. The two were written on separate branches, so this
 * test pins them together: every list the overview draws for a model must
 * find its type and fields in that model's template, or the dashboard of a
 * freshly created workspace silently loses a section.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_TEMPLATES } from "@bcontext-dev/contract/business/templates";
import type { RecordTypeDefinition } from "@bcontext-dev/contract/business/record-types";
import { accountsAtRisk, customerMrrField, findField, findRole, requestsBySegment, type RecordRole } from "./overview";
import { relationFieldsTo } from "./records";

function nodeTypes(model: keyof typeof BUSINESS_TEMPLATES): RecordTypeDefinition[] {
  // The overview reads node-stored types only; dataset rows are not pages.
  return BUSINESS_TEMPLATES[model].record_types.filter((type) => type.storage === "node") as RecordTypeDefinition[];
}

function role(model: keyof typeof BUSINESS_TEMPLATES, r: RecordRole): RecordTypeDefinition {
  const type = findRole(nodeTypes(model), r);
  expect(type, `${model}: no node type plays ${r}`).not.toBeNull();
  return type!;
}

describe("templates and the business overview agree on names", () => {
  it("b2b: accounts (mrr, health, renewal), deals (stage, amount, probability), requests by MRR and segment", () => {
    const account = role("b2b", "customer");
    expect(account.key).toBe("account");
    expect(customerMrrField(account)?.key).toBe("mrr");
    // Both `status: at_risk` and `health: red` flag an account.
    const at = (id: string, fields: Record<string, unknown>) => ({ id, kind: "account", title: id, data: { fields } });
    const flagged = accountsAtRisk([at("a", { status: "active", health: "red" }), at("b", { status: "at_risk", health: "green" }), at("c", { status: "active", health: "green" })], account, String);
    expect(flagged?.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(findField(account, /renew/, ["date"])?.key).toBe("renewal_date");

    const deal = role("b2b", "deal");
    expect(deal.stage_field).toBe("stage");
    expect(findField(deal, /^(amount|value|deal_value|arr|mrr|size)$/, ["money", "number"])?.key).toBe("amount");
    expect(findField(deal, /^(probability|win_probability|likelihood|confidence)$/, ["number"])?.key).toBe("probability");

    const request = role("b2b", "request");
    expect(relationFieldsTo(request, account.key).length).toBeGreaterThan(0);
    expect(requestsBySegment([], request)).toEqual([]);
  });

  it("b2c: customers are dataset rows (no list), requests group by their segment records", () => {
    expect(findRole(nodeTypes("b2c"), "customer")).toBeNull();
    const request = role("b2c", "request");
    const segment = { id: "s1", kind: "segment", title: "Students" };
    const rows = requestsBySegment(
      [{ id: "r1", kind: "request", title: "Dark mode", data: { fields: { segments: [segment.id] } } }],
      request,
      (id) => (id === segment.id ? segment.title : undefined),
    );
    expect(rows).toEqual([{ segment: "Students", count: 1 }]);
  });

  it("marketplace: zones carry demand and supply, incidents and requests by side are there", () => {
    const zone = role("marketplace", "zone");
    expect(findField(zone, /(demand|searches|requests|buyers|bookings)/, ["number", "money"])?.key).toBe("demand");
    expect(findField(zone, /(supplier|supply|providers|hosts)/, ["number"])?.key).toBe("active_suppliers");
    role("marketplace", "incident");
    const request = role("marketplace", "request");
    expect(findField(request, /^(segment|audience|side|persona|customer_type|user_type)$/, ["select", "text"])?.key).toBe("side");
  });
});
