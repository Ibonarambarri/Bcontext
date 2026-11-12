import { describe, expect, it } from "vitest";
import type { BusinessEvent } from "@bcontext-dev/contract/business/events";
import type { RecordTypeDefinition } from "@bcontext-dev/contract/business/record-types";
import { describeEvent, formatFieldValue, headerFields, isHubType, labelInSentence, mrrHistory, promoteUnavailableNote, relatedGroups } from "./records";

const account: RecordTypeDefinition = {
  key: "account",
  label: "Account",
  label_plural: "Accounts",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "notes", label: "Notes", type: "text" },
    { key: "mrr", label: "MRR", type: "money" },
    { key: "stage", label: "Stage", type: "select", options: ["trial", "customer"] },
    { key: "owner_deal", label: "Main deal", type: "relation", target: "deal" },
  ],
};
const contact: RecordTypeDefinition = {
  key: "contact",
  label: "Contact",
  storage: "node",
  fields: [{ key: "account", label: "Account", type: "relation", target: "account" }],
};
const deal: RecordTypeDefinition = {
  key: "deal",
  label: "Deal",
  storage: "node",
  stage_field: "stage",
  fields: [
    { key: "stage", label: "Stage", type: "select", options: ["lead", "won"] },
    { key: "account", label: "Account", type: "relation", target: "account" },
  ],
};

describe("record fields", () => {
  it("formats each type, and never prints a missing value as 0", () => {
    expect(formatFieldValue({ type: "money" }, { amount: 490, currency: "EUR" })).toBe("€490");
    expect(formatFieldValue({ type: "boolean" }, false)).toBe("No");
    expect(formatFieldValue({ type: "date" }, "2026-11-20")).toBe("Nov 20, 2026");
    expect(formatFieldValue({ type: "number" }, null)).toBe("—");
    // A dataset MRR is a number in the reporting currency.
    expect(formatFieldValue({ type: "number", unit: "money" }, 9.99, { currency: "EUR" })).toBe("€9.99");
    expect(formatFieldValue({ type: "number" }, 9.99, { currency: "EUR" })).toBe("9.99");
    expect(formatFieldValue({ type: "relation" }, ["n1", "abcdef123456"], { titles: new Map([["n1", "Acme"]]) })).toBe("Acme, #abcdef12");
  });

  it("puts the stage first and long text last", () => {
    const order = headerFields(account, { notes: "x".repeat(100), mrr: { amount: 1, currency: "EUR" }, stage: "trial" }).map((f) => f.def.key);
    expect(order).toEqual(["stage", "mrr", "owner_deal", "notes"]);
  });
});

describe("relations", () => {
  it("calls a type other types point at a hub", () => {
    expect(isHubType("account", [account, contact, deal])).toBe(true);
    expect(isHubType("contact", [account, contact, deal])).toBe(false);
  });

  it("groups what relates to a record by kind: its fields, records pointing at it, and links", () => {
    const node = { id: "acc", kind: "account", title: "Acme", data: { fields: { owner_deal: "d1" } } };
    const groups = relatedGroups({
      node,
      type: account,
      types: [account, contact, deal],
      records: [
        { id: "c1", kind: "contact", title: "Ana", data: { fields: { account: "acc" } } },
        { id: "d1", kind: "deal", title: "Renewal", data: { fields: { stage: "lead", account: "acc" } } },
        { id: "d2", kind: "deal", title: "Other", data: { fields: { account: "other" } } },
      ],
      links: [
        { id: "dec1", kind: "decision", title: "Discount", via: "mentions it" },
        { id: "b1", kind: null, title: null, via: "links to" },
        { id: "acc", kind: "account", title: "Acme", via: "self" },
      ],
      index: new Map([
        ["d1", { kind: "deal", title: "Renewal" }],
        ["b1", { kind: "bug", title: "Export fails", status: "todo" }],
      ]),
    });
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Contacts", ["c1"]],
      ["Deals", ["d1"]],
      ["Bugs", ["b1"]],
      ["Decisions", ["dec1"]],
    ]);
    expect(groups[1]!.items[0]).toMatchObject({ via: "Main deal", stage: "lead" });
  });
});

describe("mrrHistory", () => {
  const event = (type: string, at: string, amount?: number, sub?: string, currency = "EUR"): BusinessEvent => ({
    id: at + type,
    workspace_id: "w",
    received_at: at,
    subject_erased_at: null,
    type,
    occurred_at: at,
    idempotency_key: at + type,
    ...(amount !== undefined ? { amount, currency } : {}),
    properties: sub ? { subscription_id: sub } : {},
  });

  it("rebuilds month-end MRR the way the rollup does", () => {
    const history = mrrHistory([
      event("subscription.started", "2026-08-10T00:00:00Z", 100, "s1"),
      event("subscription.started", "2026-09-05T00:00:00Z", 50, "s2"),
      event("subscription.changed", "2026-10-01T00:00:00Z", 150, "s1"),
      event("subscription.canceled", "2026-11-03T00:00:00Z", undefined, "s2"),
      event("subscription.started", "2026-11-04T00:00:00Z", 999, "s3", "USD"),
    ], "EUR", new Date("2026-11-12T00:00:00Z"), 5);
    expect(history).toEqual([
      { period: "2026-07", mrr: 0 },
      { period: "2026-08", mrr: 100 },
      { period: "2026-09", mrr: 150 },
      { period: "2026-10", mrr: 200 },
      { period: "2026-11", mrr: 150 },
    ]);
  });

  it("describes events in words", () => {
    expect(describeEvent(event("subscription.started", "2026-11-01T00:00:00Z", 490), "EUR")).toBe("Subscription started · €490/mo");
    expect(describeEvent({ type: "feature.used", properties: {} }, "EUR")).toBe("feature.used");
    expect(describeEvent({ type: "booking.created", amount: 90, currency: "EUR", properties: {}, role: "supplier" }, "EUR")).toBe("Booked with them · €90");
  });
});

describe("labelInSentence", () => {
  it("lower-cases a label for a sentence but keeps a leading acronym", () => {
    expect(labelInSentence("Lead instructor")).toBe("lead instructor");
    expect(labelInSentence("VIP customer")).toBe("VIP customer");
    expect(labelInSentence("Account")).toBe("account");
    expect(labelInSentence("A")).toBe("a");
  });
});

describe("promoteUnavailableNote", () => {
  it("explains why rows cannot be converted, and says nothing when a target fits", () => {
    const supplier = { key: "supplier", label: "Instructor", label_plural: "Instructors" };
    expect(promoteUnavailableNote(supplier, [])).toMatch(/^Instructors stay rows: no node record type shares compatible fields/);
    // Name and email no longer make a type a target; the note says what does.
    expect(promoteUnavailableNote(supplier, [])).toContain("promotes_from: supplier");
    expect(promoteUnavailableNote(supplier, [])).toContain("beyond name, email or zone");
    expect(promoteUnavailableNote(supplier, [{ key: "vip", label: "VIP" }])).toBeNull();
  });
});

describe("money in the timeline", () => {
  // v0.4.1 browser pass: "€90.00" sat next to "€150" in one timeline.
  it("writes every amount with the one rule the tables and KPIs use", () => {
    const line = (amount: number) => describeEvent({ type: "booking.created", amount, currency: "EUR", properties: {} }, "EUR");
    expect(line(90)).toBe("Booking · €90");
    expect(line(150)).toBe("Booking · €150");
    expect(line(49.9)).toBe("Booking · €49.90");
    expect(describeEvent({ type: "subscription.started", amount: 1990, currency: "USD", properties: {} }, "EUR")).toBe("Subscription started · $1,990/mo");
  });
});
