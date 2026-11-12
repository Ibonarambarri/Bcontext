/**
 * The curl examples of the "How to send data" panel, written from the
 * ingest API docs (`docs/ingest-api.md`) and the contract's event vocabulary
 * (`business/events.ts`): a subscription event, an expense, a record batch.
 *
 * Who uses it: the workspace panel's Ingest keys section. Pure and tested,
 * so an example that drifts from the contract (an event without its
 * required property) fails `ingest-examples.test.ts` rather than a person's
 * first call.
 *
 * Must not break: with no key in hand the examples carry a placeholder,
 * never a real secret from anywhere else.
 */
import { INGEST_KEY_PREFIX } from "@bcontext-dev/contract/business/ingest";
import { businessPaths } from "./endpoints";

export interface IngestExample {
  title: string;
  note: string;
  command: string;
  /** The JSON body, for the test to validate against the contract. */
  body: unknown;
}

export function ingestExamples({ origin, slug, key }: { origin: string; slug: string; key?: string }): IngestExample[] {
  const token = key ?? `${INGEST_KEY_PREFIX}…`;
  const curl = (path: string, body: unknown) =>
    [
      `curl -X POST ${origin.replace(/\/$/, "")}${path} \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`,
    ].join("\n");

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
  const expense = {
    type: "expense.recorded",
    occurred_at: "2026-11-03T00:00:00Z",
    idempotency_key: "inv-2026-11-aws",
    amount: 1280,
    currency: "EUR",
    properties: { category: "infra", vendor: "AWS", recurring: true },
  };
  const records = {
    records: [
      { external_id: "cus_42", title: "Acme Corp", fields: {} },
    ],
  };

  return [
    {
      title: "A subscription starts",
      note: "amount is the subscription's monthly amount; send subscription.changed with the new amount and subscription.canceled when it ends.",
      command: curl(businessPaths.events(slug), subscription),
      body: subscription,
    },
    {
      title: "An expense",
      note: "category is one of infra, ai, tools, payroll, marketing, other. cash.balance with the amount on hand unlocks runway.",
      command: curl(businessPaths.events(slug), expense),
      body: expense,
    },
    {
      title: "Customers as records",
      note: "Upserts by external_id (your primary key). fields are validated against the record type — see Record types for its fields.",
      command: curl(businessPaths.records(slug, "account"), records),
      body: records,
    },
  ];
}
