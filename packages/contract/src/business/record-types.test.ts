import { describe, expect, it } from "vitest";
import {
  RecordTypeInputSchema,
  buildRecordFieldsSchema,
  compactRecordTypes,
  definitionIssues,
  isValidKindFor,
  matchesFieldFilters,
  unknownKindMessage,
  validKindsFor,
  validateRecordFields,
  type RecordTypeDefinition,
} from "./record-types.js";
import { ViewQuerySchema } from "../views/schema.js";

const account: RecordTypeDefinition = {
  key: "account",
  label: "Account",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "mrr", label: "MRR", type: "money", required: true },
    { key: "seats", label: "Seats", type: "number" },
    { key: "stage", label: "Stage", type: "select", options: ["lead", "trial", "customer", "churned"] },
    { key: "plans", label: "Plans", type: "multi_select", options: ["core", "ai"] },
    { key: "renewal", label: "Renewal", type: "date" },
    { key: "site", label: "Site", type: "url" },
    { key: "billing_email", label: "Billing email", type: "email" },
    { key: "owner", label: "Owner", type: "person" },
    { key: "champion", label: "Champion", type: "relation", target: "contact" },
    { key: "enterprise", label: "Enterprise", type: "boolean" },
  ],
};

describe("record type definitions", () => {
  it("accepts a well-formed type and defaults storage to node", () => {
    const parsed = RecordTypeInputSchema.parse({ key: "deal", label: "Deal", fields: [] });
    expect(parsed.storage).toBe("node");
  });

  it("refuses a key that is a core kind, with the list of core kinds", () => {
    const result = RecordTypeInputSchema.safeParse({ key: "task", label: "Task" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain("core kind");
  });

  it("refuses non-slug keys", () => {
    for (const key of ["Account", "a", "1abc", "acc-ount", "x".repeat(41)]) {
      expect(RecordTypeInputSchema.safeParse({ key, label: "X" }).success, key).toBe(false);
    }
  });

  it("checks select options, relation targets, duplicate keys and the stage field", () => {
    const bad = RecordTypeInputSchema.safeParse({
      key: "deal",
      label: "Deal",
      fields: [
        { key: "stage", label: "Stage", type: "select" },
        { key: "acct", label: "Account", type: "relation" },
        { key: "acct", label: "Again", type: "text" },
      ],
      stage_field: "amount",
    });
    expect(bad.success).toBe(false);
    const text = bad.error!.issues.map((issue) => issue.message).join("\n");
    expect(text).toContain("needs options");
    expect(text).toContain("needs a target");
    expect(text).toContain("appears twice");
    expect(text).toContain("stage_field");
  });

  it("needs a dataset for dataset storage and refuses one for node storage", () => {
    expect(RecordTypeInputSchema.safeParse({ key: "client", label: "Client", storage: "dataset" }).success).toBe(false);
    expect(RecordTypeInputSchema.safeParse({ key: "client", label: "Client", storage: "dataset", dataset_node_id: "n1" }).success).toBe(true);
    expect(RecordTypeInputSchema.safeParse({ key: "client", label: "Client", dataset_node_id: "n1" }).success).toBe(false);
  });

  it("keeps dataset-backed types to cell-compatible fields", () => {
    const result = RecordTypeInputSchema.safeParse({
      key: "client", label: "Client", storage: "dataset", dataset_node_id: "d",
      fields: [{ key: "ltv", label: "LTV", type: "money" }, { key: "zone", label: "Zone", type: "text" }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain("`ltv` is a money");
  });

  it("re-checks a merged definition", () => {
    expect(definitionIssues(account)).toEqual([]);
    expect(definitionIssues({ ...account, stage_field: "seats" }).join()).toContain("stage_field");
  });
});

describe("kinds", () => {
  const types = [account, { key: "client", label: "Client", storage: "dataset" as const, dataset_node_id: "d", fields: [] }];
  it("valid kinds are the core kinds plus node record types", () => {
    expect(validKindsFor(types)).toContain("task");
    expect(validKindsFor(types)).toContain("account");
    expect(validKindsFor(types)).not.toContain("client");
    expect(isValidKindFor("account", types)).toBe(true);
    expect(isValidKindFor("client", types)).toBe(false);
    expect(isValidKindFor("deal", types)).toBe(false);
  });

  it("names what exists when a kind does not", () => {
    expect(unknownKindMessage("deal", types)).toMatch(/record types: account$/);
    expect(unknownKindMessage("deal", [])).toContain("defines no record types");
  });

  it("view queries accept record type keys by shape", () => {
    expect(ViewQuerySchema.parse({ schema_version: 1, kinds: ["account", "task"] }).kinds).toEqual(["account", "task"]);
    expect(ViewQuerySchema.safeParse({ schema_version: 1, kinds: ["Not A Kind"] }).success).toBe(false);
  });
});

describe("field values", () => {
  it("accepts a valid record", () => {
    const result = validateRecordFields(account, {
      mrr: { amount: 490, currency: "EUR" },
      seats: 12,
      stage: "customer",
      plans: ["core", "ai"],
      renewal: "2027-01-31",
      site: "https://acme.test",
      billing_email: "billing@acme.test",
      owner: "0f8fad5b-d9cb-469f-a165-70867728950e",
      champion: "node-1",
      enterprise: true,
    });
    expect(result.ok).toBe(true);
  });

  it("names every bad field, and unknown ones with the real list", () => {
    const result = validateRecordFields(account, {
      mrr: 490,
      seats: "twelve",
      stage: "won",
      site: "ftp://x",
      mmr: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byField = Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message]));
    expect(byField.mrr).toContain("{amount, currency}");
    expect(byField.seats).toContain("expected a number");
    expect(byField.stage).toContain("lead | trial | customer | churned");
    expect(byField.site).toContain("http(s)");
    expect(byField.mmr).toContain("not a field of account");
    expect(byField.mmr).toContain("mrr, seats");
    expect(result.message).toMatch(/^invalid fields for account: /);
  });

  it("demands required fields on create but not on patch", () => {
    const create = validateRecordFields(account, { seats: 3 });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.message).toContain("field `mrr`: is required");
    expect(validateRecordFields(account, { seats: 3 }, "patch").ok).toBe(true);
    // ...but a patch cannot clear a required field
    expect(validateRecordFields(account, { mrr: null }, "patch").ok).toBe(false);
    // and an optional field can be cleared
    expect(validateRecordFields(account, { seats: null }, "patch").ok).toBe(true);
  });

  it("validates relation lists and dates", () => {
    const multi = { key: "deal", fields: [{ key: "contacts", label: "C", type: "relation" as const, target: "contact", multiple: true }, { key: "close", label: "Close", type: "date" as const }] };
    expect(buildRecordFieldsSchema(multi).safeParse({ contacts: ["a", "b"], close: "2026-11-12T10:00:00Z" }).success).toBe(true);
    expect(buildRecordFieldsSchema(multi).safeParse({ contacts: "a" }).success).toBe(false);
    expect(buildRecordFieldsSchema(multi).safeParse({ close: "next week" }).success).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(validateRecordFields(account, [1, 2]).ok).toBe(false);
  });
});

describe("field filters", () => {
  const fields = { mrr: { amount: 500, currency: "EUR" }, stage: "customer", plans: ["core"], renewal: "2027-01-31" };
  it("eq / in / gt / lt, money on its amount, dates as ISO strings, lists by membership", () => {
    expect(matchesFieldFilters(fields, [{ field: "stage", op: "eq", value: "customer" }])).toBe(true);
    expect(matchesFieldFilters(fields, [{ field: "stage", op: "in", value: ["lead", "customer"] }])).toBe(true);
    expect(matchesFieldFilters(fields, [{ field: "mrr", op: "gt", value: 400 }])).toBe(true);
    expect(matchesFieldFilters(fields, [{ field: "mrr", op: "lt", value: 400 }])).toBe(false);
    expect(matchesFieldFilters(fields, [{ field: "renewal", op: "lt", value: "2027-06-01" }])).toBe(true);
    expect(matchesFieldFilters(fields, [{ field: "plans", op: "eq", value: "core" }])).toBe(true);
    expect(matchesFieldFilters(fields, [{ field: "seats", op: "gt", value: 1 }])).toBe(false);
  });
});

describe("compactRecordTypes", () => {
  it("is short and complete enough to write a record", () => {
    const [compact] = compactRecordTypes([account]);
    expect(compact).toEqual({
      key: "account",
      label: "Account",
      fields:
        "mrr:money*,seats:number,stage:select,plans:multi_select(core|ai),renewal:date,site:url,billing_email:email,owner:person,champion:relation→contact,enterprise:boolean",
      stages: ["lead", "trial", "customer", "churned"],
    });
  });
});
