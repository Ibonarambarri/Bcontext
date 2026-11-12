/**
 * The curl examples of the "How to send data" panel, written from the
 * ingest API docs (`docs/ingest-api.md`) and the contract's event vocabulary
 * (`business/events.ts`), for the workspace's business model: what a b2b or
 * product team sends (a subscription on an account), a b2c app (a
 * subscription on a customer row), a marketplace (a booking with its
 * supplier and fee) — then an expense, and a batch of the model's main
 * record type, shaped like its template's fields.
 *
 * Who uses it: the workspace panel's Ingest keys section. Pure and tested,
 * so an example that drifts from the contract (an event without its
 * required property, a record field the template does not have) fails
 * `settings.test.ts` rather than a person's first call.
 *
 * Must not break: with no key in hand the examples carry a placeholder,
 * never a real secret from anywhere else. Ids are opaque (`cli_7781`, never
 * an email), as the docs' GDPR section asks.
 */
import { INGEST_KEY_PREFIX } from "@bcontext-dev/contract/business/ingest";
import type { BusinessModel } from "@bcontext-dev/contract/business/record-types";
import { businessPaths } from "./endpoints";

export interface IngestExample {
  title: string;
  note: string;
  command: string;
  /** The JSON body, for the test to validate against the contract. */
  body: unknown;
  /** Records examples: the record type the path writes to. */
  record_type?: string;
}

export function ingestExamples({ origin, slug, key, model = "b2b" }: { origin: string; slug: string; key?: string; model?: BusinessModel }): IngestExample[] {
  const token = key ?? `${INGEST_KEY_PREFIX}…`;
  const curl = (path: string, body: unknown) =>
    [
      `curl -X POST ${origin.replace(/\/$/, "")}${path} \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`,
    ].join("\n");

  const expense = {
    type: "expense.recorded",
    occurred_at: "2026-11-03T00:00:00Z",
    idempotency_key: "inv-2026-11-aws",
    amount: 1280,
    currency: "EUR",
    properties: { category: "infra", vendor: "AWS", recurring: true },
  };
  const expenseExample: IngestExample = {
    title: "An expense",
    note: "category is one of infra, ai, tools, payroll, marketing, other. cash.balance with the amount on hand unlocks runway.",
    command: curl(businessPaths.events(slug), expense),
    body: expense,
  };
  const records = (type: string, body: unknown, title: string, note: string): IngestExample => ({
    title,
    note,
    command: curl(businessPaths.records(slug, type), body),
    body,
    record_type: type,
  });

  if (model === "marketplace") {
    const booking = {
      type: "booking.created",
      occurred_at: "2026-12-20T09:15:00Z",
      idempotency_key: "bk_9931-created",
      subject_id: "cli_7781",
      amount: 180,
      currency: "EUR",
      properties: { booking_id: "bk_9931", supplier_id: "ins_204", fee: 27, zone: "baqueira" },
    };
    return [
      {
        title: "A booking",
        note: "subject_id is the buyer, amount the booking's gross value and fee your take. Send booking.completed or booking.canceled with the same booking_id when it ends.",
        command: curl(businessPaths.events(slug), booking),
        body: booking,
      },
      expenseExample,
      records(
        "supplier",
        { records: [{ external_id: "ins_204", fields: { zone: "baqueira", status: "active", rating: 4.8, joined_on: "2026-10-01" } }] },
        "Suppliers as records",
        "Upserts by external_id — the same id bookings carry as supplier_id. fields are validated against the record type — see Record types for its fields.",
      ),
    ];
  }

  if (model === "b2c") {
    const subscription = {
      type: "subscription.started",
      occurred_at: "2026-11-01T09:30:00Z",
      idempotency_key: "sub_8812-started",
      subject_type: "customer",
      subject_id: "cus_8812",
      amount: 9.99,
      currency: "EUR",
      properties: { subscription_id: "sub_8812", plan: "plus" },
    };
    return [
      {
        title: "A subscription starts",
        note: "subject_id is the customer's id in your app; amount is the monthly amount. Send subscription.changed with the new amount and subscription.canceled when it ends.",
        command: curl(businessPaths.events(slug), subscription),
        body: subscription,
      },
      expenseExample,
      records(
        "customer",
        { records: [{ external_id: "cus_8812", fields: { plan: "plus", status: "active", mrr: 9.99, signup_date: "2026-11-01", country: "ES" } }] },
        "Customers as rows",
        "Upserts by external_id into the Customers dataset: people stay rows, not nodes. Send your id, not their email.",
      ),
    ];
  }

  // b2b, and a product team that bills accounts.
  const subscription = {
    type: "subscription.started",
    occurred_at: "2026-11-01T09:30:00Z",
    idempotency_key: "sub_123-started",
    subject_type: "account",
    subject_id: "cus_42",
    amount: 490,
    currency: "EUR",
    properties: { subscription_id: "sub_123" },
  };
  return [
    {
      title: "A subscription starts",
      note: "amount is the subscription's monthly amount; send subscription.changed with the new amount and subscription.canceled when it ends.",
      command: curl(businessPaths.events(slug), subscription),
      body: subscription,
    },
    expenseExample,
    records(
      "account",
      { records: [{ external_id: "cus_42", title: "Acme Corp", fields: { status: "active", plan: "pro", mrr: { amount: 490, currency: "EUR" } } }] },
      "Accounts as records",
      "Upserts by external_id (your primary key). fields are validated against the record type — see Record types for its fields.",
    ),
  ];
}
