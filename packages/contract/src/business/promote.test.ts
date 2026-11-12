import { describe, expect, it } from "vitest";
import {
  RecordTypeInputSchema,
  RecordTypePatchSchema,
  fieldValueFits,
  isGenericField,
  promoteFit,
  promoteTargetsFor,
  type RecordTypeDefinition,
} from "./record-types.js";
import { BUSINESS_TEMPLATES, type TemplateRecordType } from "./templates.js";

/**
 * "Convert to node" offers only targets a row can actually become. The
 * browser pass that found it: a marketplace supplier was offered "Convert to
 * incident", which shares `status`/`zone` by name but not by meaning, and
 * every click was a 400.
 */

const asDefinition = (type: TemplateRecordType): RecordTypeDefinition => ({ ...type, dataset_node_id: type.storage === "dataset" ? "ds" : null });
const templateTypes = (model: keyof typeof BUSINESS_TEMPLATES) => BUSINESS_TEMPLATES[model].record_types.map(asDefinition);

describe("fieldValueFits", () => {
  it("takes the same type, and a select only into a select that has all its options", () => {
    expect(fieldValueFits({ type: "number" }, { type: "number" })).toBe(true);
    expect(fieldValueFits({ type: "select", options: ["a", "b"] }, { type: "select", options: ["a", "b", "c"] })).toBe(true);
    expect(fieldValueFits({ type: "select", options: ["active"] }, { type: "select", options: ["open"] })).toBe(false);
  });

  it("widens string values into text, and nothing else", () => {
    expect(fieldValueFits({ type: "email" }, { type: "text" })).toBe(true);
    expect(fieldValueFits({ type: "text" }, { type: "email" })).toBe(false);
    expect(fieldValueFits({ type: "text" }, { type: "relation" })).toBe(false);
    expect(fieldValueFits({ type: "number" }, { type: "money" })).toBe(false);
  });
});

describe("promote targets from the templates", () => {
  it("offers a marketplace supplier or buyer nothing: no node type there fits them", () => {
    const types = templateTypes("marketplace");
    for (const key of ["supplier", "buyer"]) {
      const source = types.find((type) => type.key === key)!;
      expect(promoteTargetsFor(source, types), key).toEqual([]);
    }
    // The case from the browser pass, spelled out.
    const incident = types.find((type) => type.key === "incident")!;
    const fit = promoteFit(types.find((type) => type.key === "supplier")!, incident);
    expect(fit.mapping).toEqual({});
    expect(fit.missing_required).toEqual(["status", "severity"]);
  });

  it("offers a b2c customer nothing either", () => {
    const types = templateTypes("b2c");
    expect(promoteTargetsFor(types.find((type) => type.key === "customer")!, types)).toEqual([]);
  });

  it("offers a node type a team adds for the purpose, best match first", () => {
    const types = templateTypes("marketplace");
    const supplier = types.find((type) => type.key === "supplier")!;
    const vip: RecordTypeDefinition = {
      key: "key_instructor",
      label: "Key instructor",
      storage: "node",
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "rating", label: "Rating", type: "number" },
      ],
    };
    const coach: RecordTypeDefinition = {
      key: "coach",
      label: "Coach",
      storage: "node",
      fields: [
        { key: "rating", label: "Rating", type: "number" },
        { key: "joined_on", label: "Joined", type: "date" },
      ],
    };
    expect(promoteTargetsFor(supplier, [...types, vip, coach])).toEqual([
      { key: "coach", label: "Coach" },
      { key: "key_instructor", label: "Key instructor" },
    ]);
    expect(promoteFit(supplier, vip).mapping).toEqual({ name: "name", email: "email", rating: "rating" });
  });
});

describe("generic fields do not make two types related", () => {
  // The v0.4.1 browser pass: once a "lead instructor" type existed, every
  // marketplace client row offered "Convert to lead instructor" — they share
  // a name, an email and a zone, and nothing else.
  const leadInstructor: RecordTypeDefinition = {
    key: "lead_instructor",
    label: "Lead instructor",
    storage: "node",
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "email", label: "Email", type: "email" },
      { key: "zone", label: "Zone", type: "text" },
      { key: "rating", label: "Rating", type: "number" },
      { key: "certification", label: "Certification", type: "text" },
    ],
  };

  it("offers a lead instructor to suppliers (a rating in common), never to clients", () => {
    const types = [...templateTypes("marketplace"), leadInstructor];
    const supplier = types.find((type) => type.key === "supplier")!;
    const buyer = types.find((type) => type.key === "buyer")!;
    expect(promoteTargetsFor(supplier, types)).toEqual([{ key: "lead_instructor", label: "Lead instructor" }]);
    expect(promoteTargetsFor(buyer, types)).toEqual([]);
  });

  it("treats name, email, phone, zone, country and the like as generic", () => {
    for (const key of ["name", "email", "phone", "zone", "country", "title", "city", "status"]) {
      expect(isGenericField({ key, type: "text" }), key).toBe(true);
    }
    expect(isGenericField({ key: "contact", type: "email" })).toBe(true);
    expect(isGenericField({ key: "rating", type: "number" })).toBe(false);
    expect(isGenericField({ key: "plan", type: "text" })).toBe(false);
  });

  it("offers a type sharing only generic fields when it declares the source in promotes_from", () => {
    const types = templateTypes("marketplace");
    const buyer = types.find((type) => type.key === "buyer")!;
    const vipClient: RecordTypeDefinition = {
      key: "vip_client",
      label: "VIP client",
      storage: "node",
      promotes_from: ["buyer"],
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
      ],
    };
    expect(promoteTargetsFor(buyer, [...types, vipClient])).toEqual([{ key: "vip_client", label: "VIP client" }]);
    // Declared first, ahead of a type that only shares a field.
    const regular: RecordTypeDefinition = { key: "regular", label: "Regular", storage: "node", fields: [{ key: "bookings", label: "Bookings", type: "number" }] };
    expect(promoteTargetsFor(buyer, [...types, regular, vipClient]).map((t) => t.key)).toEqual(["vip_client", "regular"]);
  });

  it("offers a type that declares other sources to none but those", () => {
    const types = templateTypes("marketplace");
    const supplier = types.find((type) => type.key === "supplier")!;
    const declared = { ...leadInstructor, promotes_from: ["buyer"] };
    expect(promoteTargetsFor(supplier, [...types, declared])).toEqual([]);
  });

  it("still demands every required field, declared or not", () => {
    const types = templateTypes("marketplace");
    const buyer = types.find((type) => type.key === "buyer")!;
    const strict: RecordTypeDefinition = {
      key: "ambassador",
      label: "Ambassador",
      storage: "node",
      promotes_from: ["buyer"],
      fields: [{ key: "code", label: "Code", type: "text", required: true }],
    };
    expect(promoteTargetsFor(buyer, [...types, strict])).toEqual([]);
  });
});

describe("record type settings", () => {
  const base = { key: "lead_instructor", label: "Lead instructor", fields: [{ key: "rating", label: "Rating", type: "number" as const, total: "average" as const }] };

  it("takes promotes_from on a node type and a total on a number", () => {
    expect(RecordTypeInputSchema.safeParse({ ...base, promotes_from: ["supplier"] }).success).toBe(true);
    expect(RecordTypePatchSchema.safeParse({ promotes_from: null }).success).toBe(true);
  });

  it("refuses a total on a text field, promotes_from on a dataset type, and a self-reference", () => {
    const text = RecordTypeInputSchema.safeParse({ ...base, fields: [{ key: "bio", label: "Bio", type: "text", total: "sum" }] });
    expect(text.success).toBe(false);
    const dataset = RecordTypeInputSchema.safeParse({ ...base, storage: "dataset", dataset_node_id: "ds", promotes_from: ["supplier"] });
    expect(dataset.success).toBe(false);
    expect(RecordTypeInputSchema.safeParse({ ...base, promotes_from: ["lead_instructor"] }).success).toBe(false);
  });
});
