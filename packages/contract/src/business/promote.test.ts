import { describe, expect, it } from "vitest";
import { fieldValueFits, promoteFit, promoteTargetsFor, type RecordTypeDefinition } from "./record-types.js";
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
    const note: RecordTypeDefinition = { key: "note_card", label: "Note", storage: "node", fields: [{ key: "email", label: "Email", type: "text" }] };
    expect(promoteTargetsFor(supplier, [...types, note, vip])).toEqual([
      { key: "key_instructor", label: "Key instructor" },
      { key: "note_card", label: "Note" },
    ]);
    expect(promoteFit(supplier, vip).mapping).toEqual({ name: "name", email: "email", rating: "rating" });
  });
});
