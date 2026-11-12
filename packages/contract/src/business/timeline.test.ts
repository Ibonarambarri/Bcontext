import { describe, expect, it } from "vitest";
import { businessEventTone, describeBusinessEvent, type BusinessTimelineEvent } from "./timeline.js";

const base: BusinessTimelineEvent = {
  id: "e1",
  type: "subscription.changed",
  occurred_at: "2026-03-01T00:00:00Z",
  subject_type: "account",
  subject_id: "acme",
  amount: 450,
  currency: "EUR",
  properties: {},
  role: "subject",
};

describe("describeBusinessEvent", () => {
  it("reads canonical events as one line", () => {
    expect(describeBusinessEvent(base, "en-GB")).toBe("Plan changed to €450/mo");
    expect(describeBusinessEvent({ ...base, type: "subscription.canceled", amount: null })).toBe("Subscription canceled");
    expect(describeBusinessEvent({ ...base, type: "booking.created", amount: 80, role: "supplier" }, "en-GB")).toBe("Booked · €80");
  });

  it("never hides an unknown type", () => {
    expect(describeBusinessEvent({ ...base, type: "trial.extended", amount: null })).toBe("trial.extended");
  });

  it("colours good and bad news", () => {
    expect(businessEventTone({ type: "subscription.started" })).toBe("positive");
    expect(businessEventTone({ type: "subscription.canceled" })).toBe("negative");
    expect(businessEventTone({ type: "cash.balance" })).toBe("neutral");
  });
});
