import { describe, expect, it } from "vitest";
import { SIDE_WORDS, TEMPLATE_SIDE_VIEW_NAMES, displayViewName, renameSides, sideNames } from "./names.js";
import { BUSINESS_TEMPLATES, templateViewMarker } from "./templates.js";

const renamed = sideNames([
  { key: "supplier", label: "Instructor", label_plural: "Instructors" },
  { key: "buyer", label: "Client", label_plural: null },
  { key: "zone", label: "Resort", label_plural: "Resorts" },
]);

describe("side names", () => {
  it("knows only the sides a workspace renamed", () => {
    expect(renamed).toEqual({ supplier: { one: "Instructor", many: "Instructors" }, buyer: { one: "Client", many: "Clients" } });
    expect(sideNames([{ key: "supplier", label: "Supplier", label_plural: "Suppliers" }])).toEqual({});
  });

  it("rewrites KPI labels and sentences, keeping number and capitals", () => {
    expect(renameSides("Active suppliers", renamed)).toBe("Active instructors");
    expect(renameSides("Repeat buyers", renamed)).toBe("Repeat clients");
    expect(renameSides("Suppliers", renamed)).toBe("Instructors");
    expect(renameSides("bookings per supplier", renamed)).toBe("bookings per instructor");
    expect(renameSides("Distinct suppliers with a non-canceled booking", renamed)).toBe("Distinct instructors with a non-canceled booking");
    // An unrenamed side, and words that merely contain one, are untouched.
    expect(renameSides("Active customers", renamed)).toBe("Active customers");
    expect(renameSides("supplierish", renamed)).toBe("supplierish");
  });

  it("keeps an acronym's capitals mid-sentence", () => {
    const vip = sideNames([{ key: "buyer", label: "VIP client", label_plural: "VIP clients" }]);
    expect(renameSides("New buyers", vip)).toBe("New VIP clients");
  });

  it("renames a template view only while it carries the template's name", () => {
    const view = (name: string) => ({ name, presentation: { layout: { template: "marketplace:suppliers" } } });
    expect(displayViewName(view("Suppliers"), renamed)).toBe("Instructors");
    expect(displayViewName(view("Our instructors"), renamed)).toBe("Our instructors");
    expect(displayViewName({ name: "Suppliers", presentation: { layout: {} } }, renamed)).toBe("Suppliers");
  });
});

describe("template view names", () => {
  it("lists exactly the template views whose name says a side", () => {
    const sideWord = new RegExp(`\\b(${SIDE_WORDS.join("|")})s?\\b`, "i");
    const expected: Record<string, string> = {};
    for (const template of Object.values(BUSINESS_TEMPLATES)) {
      for (const view of template.views) if (sideWord.test(view.name)) expected[templateViewMarker(template.model, view.key)] = view.name;
    }
    expect(TEMPLATE_SIDE_VIEW_NAMES).toEqual(expected);
  });
});
