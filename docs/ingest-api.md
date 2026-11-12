# Business layer: record types, the ingest API and metrics

A workspace can also know a SaaS company's business: its customers, its money
and its usage. Three pieces make that up:

- **Record types**: kinds the workspace defines for itself (`account`,
  `contact`, `deal`, `zone`…), with typed fields. Agents and people write
  them like any other node. A B2C business keeps its people in a dataset
  instead.
- **The ingest API**: your product pushes its own state (records, upserted by
  your id) and facts (events, append-only) to Bcontext with a write-only key.
- **Metrics**: Bcontext rolls the events up daily and monthly and serves the
  KPI set of the workspace's business model in one read.

Everything here is under `/api/workspaces/<slug>/…` on your instance (the
same origin as the web app). For the full self-hosting setup see
[self-hosting.md](self-hosting.md).

Saved views over these records (pipeline boards with stage totals, tables,
KPI dashboards with year-on-year charts, heatmaps), the templates each
business model starts with, `POST …/business/apply-template` and
`admin_write(op=apply_business_template)` are in
[business-views.md](business-views.md). Field filters there and in
`nodes(op=list)` also take `empty` (`true`: no value, `false`: has one).

## 1. Set the business model

`product` (the default) is a software team with no business metrics. Set
`b2b` or `b2c` for the subscription KPI set, or `marketplace` for GMV, take
and liquidity. `currency` is the one metrics are reported in. Bcontext does no
FX, so events in other currencies are stored and left out of money metrics.

```bash
curl -X PATCH "$BCONTEXT/api/workspaces/denak/business" \
  -H "Cookie: <session>" -H "Content-Type: application/json" \
  -d '{"business_model":"b2b","currency":"EUR"}'
```

This needs the admin verb (an owner or admin of the workspace). Agents with
the admin verb can do the same with `admin_write({ op: "set_business" })`.

## 2. Define record types

```json
{
  "key": "account",
  "label": "Account",
  "label_plural": "Accounts",
  "description": "A paying or trialling company",
  "storage": "node",
  "stage_field": "stage",
  "fields": [
    { "key": "mrr", "label": "MRR", "type": "money", "required": true, "description": "Monthly recurring revenue" },
    { "key": "stage", "label": "Stage", "type": "select", "options": ["trial", "customer", "churned"] },
    { "key": "seats", "label": "Seats", "type": "number" },
    { "key": "owner", "label": "Owner", "type": "person" },
    { "key": "champion", "label": "Champion", "type": "relation", "target": "contact" }
  ]
}
```

Create it with `POST /api/workspaces/<ws>/record-types`, change it with
`PATCH /api/workspaces/<ws>/record-types/<key>` and delete it with
`DELETE /api/workspaces/<ws>/record-types/<key>`. All three need the admin
verb. An agent with the admin verb uses `admin_write({ op: "record_type", key,
definition })` and `admin_write({ op: "delete_record_type", key })`.
`GET /api/workspaces/<ws>/record-types` is open to every member.

- **`key`** is 2–40 characters: lowercase letters, digits and `_`, starting
  with a letter. It must not be a core kind (`doc`, `task`, `decision`,
  `meeting`, `bug`, `adr`, `entity`, `skill`, `data`, `credential`, `goal`).
  The key and `storage` can't change after creation.
- **Field types:**

  | Type | Value |
  |---|---|
  | `text` | a string |
  | `number` | a number |
  | `money` | `{amount, currency}` |
  | `date` | `YYYY-MM-DD` or an ISO timestamp |
  | `boolean` | `true` or `false` |
  | `select` | one of `options` |
  | `multi_select` | a list drawn from `options` |
  | `url` | an http(s) URL |
  | `email` | an email address |
  | `person` | a user id |
  | `relation` | a node id of kind `target`; a list of ids when `multiple: true` |

- **`stage_field`** names a `select` field. Its options, in order, are the
  pipeline stages. A stage is a field and never the core `status`.
- **`description`** on a field is one line, and it's what an agent reads to
  decide what goes there.
- **`storage: "dataset"`** keeps the records as rows of a `data` node
  (`dataset_node_id`), keyed by your id, instead of as nodes. Use it for
  people in a B2C business: they are too many and too personal to be nodes.
  These types take only cell-shaped fields (`text`, `number`, `date`,
  `boolean`, `select`, `url`, `email`, `person`). A dataset-backed type is not
  a node kind. A row becomes a node when someone promotes it
  (`data_write({ op: "promote_row" })`).

A node record stores its values in `data.fields` and your id in
`data.external_id`, which is unique per workspace and kind. A promoted row
also records where it came from in `data.source_row = {dataset_node_id, key}`.

## 3. Get an ingest key

In the web app, or over HTTP, a person with the admin verb creates one:

```bash
curl -X POST "$BCONTEXT/api/workspaces/denak/ingest-keys" \
  -H "Cookie: <session>" -H "Content-Type: application/json" \
  -d '{"name":"denak-app production"}'
# → { "key": "bctx_ingest_…", "record": { "id": "…", "prefix": "bctx_ingest_AbCd", … } }
```

The plaintext is shown once. To list keys use `GET …/ingest-keys`, and to
revoke one use `DELETE …/ingest-keys/<id>`.

An ingest key is **write-only by construction**. It is accepted only by the
endpoints below. Every other route and the MCP server answer
`401 invalid_token`, because they only accept `bctx_live_…` bearers. A leaked
ingest key can push data into one workspace and can read nothing.

## 4. The ingest API

Every request sends `Authorization: Bearer bctx_ingest_…`.

| Method and path | Body | Answer |
|---|---|---|
| `PUT /api/workspaces/<ws>/records/<type>/<external_id>` | `{ title?, fields }` | `201 {status:"created", node_id}`, `200 {status:"updated"\|"unchanged"}`, `422` with the bad field |
| `POST /api/workspaces/<ws>/records/<type>` | `{ records: [{ external_id, title?, fields }] }` (≤ 500) | `200 {created, updated, unchanged, invalid, results[]}` |
| `DELETE /api/workspaces/<ws>/records/<type>/<external_id>` | none | `200 {record_removed, events_unlinked}` |
| `POST /api/workspaces/<ws>/events` | one event, or `{ events: [...] }` (≤ 1,000) | `200 {stored, duplicates, invalid, results[]}`; a single invalid event is `422` |

- **Records upsert.** The first send creates the record and later sends
  update it. Fields merge: what you send overwrites, and what you leave out
  keeps its value. Required fields are demanded only on create. An unknown
  field or a value of the wrong type is rejected with a message that names
  the field. In a batch, a bad record is reported in its own slot and the
  rest are written.
- **Events are append-only and idempotent.** `idempotency_key` is unique per
  workspace. A retry with a key that is already stored answers `duplicate`
  and stores nothing, so retry freely. A correction is a new event.
- **Limits:** record bodies up to 1 MB, event bodies up to 2 MB, and per key
  a burst of 60 requests, then 5 per second (`429` with `Retry-After` beyond
  that).
- **Errors:** `401` for a missing, unknown or revoked key; `404` for a key of
  another workspace (indistinguishable from a missing one); `503` with
  `Retry-After` when the key store could not be reached (retry, and don't
  rotate the key).

### Examples

Upsert a B2B account:

```bash
curl -X PUT "$BCONTEXT/api/workspaces/denak/records/account/acc_42" \
  -H "Authorization: Bearer $BCONTEXT_INGEST_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Acme Corp","fields":{"mrr":{"amount":490,"currency":"EUR"},"stage":"customer","seats":12}}'
```

A B2B subscription event:

```bash
curl -X POST "$BCONTEXT/api/workspaces/denak/events" \
  -H "Authorization: Bearer $BCONTEXT_INGEST_KEY" -H "Content-Type: application/json" \
  -d '{
    "type": "subscription.started",
    "occurred_at": "2026-11-01T10:00:00Z",
    "idempotency_key": "sub_1Pq9:started",
    "subject_type": "account",
    "subject_id": "acc_42",
    "amount": 490,
    "currency": "EUR",
    "properties": { "subscription_id": "sub_1Pq9", "plan": "pro" }
  }'
```

A marketplace booking event (alpify: a client books an instructor):

```bash
curl -X POST "$BCONTEXT/api/workspaces/alpify/events" \
  -H "Authorization: Bearer $BCONTEXT_INGEST_KEY" -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "booking.created",
      "occurred_at": "2026-12-20T09:15:00Z",
      "idempotency_key": "bk_9931:created",
      "subject_id": "cli_7781",
      "amount": 180,
      "currency": "EUR",
      "properties": { "booking_id": "bk_9931", "supplier_id": "ins_204", "fee": 27, "zone": "baqueira" }
    }]
  }'
```

An expense, and the cash balance runway is computed from:

```bash
curl -X POST "$BCONTEXT/api/workspaces/denak/events" \
  -H "Authorization: Bearer $BCONTEXT_INGEST_KEY" -H "Content-Type: application/json" \
  -d '{"events":[
    {"type":"expense.recorded","occurred_at":"2026-11-03T00:00:00Z","idempotency_key":"inv_aws_2026_11","amount":1240.5,"currency":"EUR","properties":{"category":"infra","vendor":"AWS","recurring":true}},
    {"type":"cash.balance","occurred_at":"2026-11-30T23:59:59Z","idempotency_key":"cash_2026_11","amount":182000,"currency":"EUR"}
  ]}'
```

## 5. Event vocabulary

Any type shaped like `noun.verb` (lowercase, dotted) is stored. Only the
types below move a metric, and they are validated strictly. An unknown type
is kept for later and ignored by the rollups. Amounts are in major units
(49.90, not 4990).

| Type | Required | Drives |
|---|---|---|
| `subscription.started` | `subject_id` (customer), `amount` = this subscription's monthly amount, `currency`; optional `properties.subscription_id` | `mrr`, `new_mrr`, `expansion_mrr`, `active_customers`, `new_customers`, revenue |
| `subscription.changed` | as above; `amount` is the **new** monthly amount, not a delta | `mrr`, `expansion_mrr`, `contraction_mrr` |
| `subscription.canceled` | `subject_id`; optional `properties.subscription_id` | `mrr`, `churned_mrr`, `churned_customers`, `active_customers` |
| `booking.created` | `subject_id` (buyer), `amount` = gross value, `currency`, `properties.booking_id`, `properties.supplier_id`; optional `properties.fee` (take, default 0) | `gmv`, `take`, `bookings`, `active_suppliers`, `active_buyers`, `new_buyers`, `repeat_buyers`, revenue |
| `booking.completed` | `properties.booking_id`; optional `amount` / `properties.fee` as final values | `gmv`, `take` |
| `booking.canceled` | `properties.booking_id` | `cancellations`, and removes the booking from `gmv`/`take` |
| `expense.recorded` | `amount` ≥ 0, `currency`, `properties.category` ∈ `infra · ai · tools · payroll · marketing · other`; optional `vendor`, `recurring` | `expenses`, `expenses_by_category`, `net`, burn |
| `cash.balance` | `amount` (cash on hand), `currency`; `occurred_at` is the as-of date | `cash_balance`, runway |

Without `subscription_id`, a customer has one subscription. A customer's MRR
is the sum of their subscriptions.

## 6. Metrics

The worker recomputes a workspace's rollups from its whole event history.
That happens about 30 seconds after events arrive (debounced) and nightly
(`business.rollup-all`, 03:10 UTC). Results go to `business_metric_rollups`,
at `day` and `month` grain.

```bash
curl "$BCONTEXT/api/workspaces/denak/metrics/summary?period=month" -H "Cookie: <session>"
```

The read verb is enough. Agents get the same answer from `data({ op: "metrics" })`.
The response is `MetricsSummary` (`packages/contract/src/business/metrics.ts`).
For each KPI it carries `current`, `previous`, `delta`, `delta_pct`,
`year_ago`, `yoy_delta_pct` and a 12-month `series`. It also includes the
current month's `expenses_by_category`.

Definitions. Days are UTC; the current month is month-to-date. Percentages
are fractions. A KPI whose inputs are missing is `null`, never 0.

**SaaS** (`b2b`, `b2c`):

| KPI | Definition |
|---|---|
| MRR | Sum of active subscriptions at month end |
| MRR growth | MRR change ÷ the previous month's MRR |
| New / expansion / contraction / churned MRR | Each customer's MRR at the start of the month is compared with its MRR at the end: 0 → >0 is new, up is expansion, down but still > 0 is contraction, >0 → 0 is churned. So month-end MRR = start + new + expansion − contraction − churned, exactly |
| Net new MRR | new + expansion − contraction − churned |
| Active customers | Customers with MRR > 0 at month end |
| New customers | Customers with MRR 0 at month start and > 0 at month end |
| Logo churn | Churned customers ÷ customers at month start |
| Revenue churn (gross) | (churned + contraction MRR) ÷ MRR at month start |
| NRR | (start MRR + expansion − contraction − churned) ÷ start MRR, monthly. It is `null` in a workspace's first month, when start MRR is 0 |
| ARPA | MRR ÷ active customers |
| Revenue (recognised) | Each day's MRR ÷ days in its month, summed (MRR prorated per day) |
| Expenses, net | Expenses = sum of `expense.recorded`; net = revenue − expenses |
| Burn | Expenses − revenue when positive, else 0 |
| Runway | Latest `cash.balance` ÷ the month's burn. It is `null` without cash, or when burn is 0 |

**Marketplace:**

| KPI | Definition |
|---|---|
| GMV and take | Gross value and fees of the bookings **created** in the month that are not canceled. A cancellation later updates the month the booking was created in |
| Take rate | Take ÷ GMV |
| Bookings | Bookings created in the month |
| Cancellation rate | Bookings created in the month and canceled since ÷ bookings created in the month |
| Active suppliers, active buyers | Distinct suppliers and buyers with a non-canceled booking in the month |
| New buyers | Active buyers whose first non-canceled booking is in the month |
| Repeat-buyer rate | Active buyers with an earlier booking ÷ active buyers |
| Revenue | Take |
| Expenses, net | As in SaaS |

The same month a year earlier (`year_ago`) is there for seasonality: a ski
school's December is compared with last December, not with November.

## 7. Personal data (GDPR)

Send the least you can. Bcontext needs your **id** for a person, not their
name or email.

- Use opaque ids (`cli_7781`, never an email) as `subject_id` and
  `external_id`. A B2C person belongs in a dataset-backed record type.
- Don't put contact details in `properties`. The event schema refuses
  unknown top-level keys, but `properties` is free-form, and what you put
  there is stored.
- **Erasure:** `DELETE /api/workspaces/<ws>/records/<type>/<external_id>`
  removes the record (node or dataset row). It also replaces the subject's id
  on all their events, as the subject and as a booking's supplier, with one
  random token. The token is not a hash of the id, which could be
  recomputed. The amounts stay, so the metrics still add up, and nothing
  leads back to the person. A promoted node of that person is a separate
  record: delete it too, through its own type.
- Events are append-only at the database level: their facts can't be
  rewritten, and only the subject link can be erased.

## 8. Agents (MCP)

There are no new tools. Record types are ordinary kinds:

- `nodes_write({ op: "create", kind: "account", title, fields })` creates a
  record. `patch.fields` on update merges into the existing fields.
- `nodes({ op: "list", kind: "account", fields: [{ field: "stage", op: "eq", value: "customer" }] })`
  filters on fields. The operators are `eq`, `in`, `gt` and `lt`, and each
  result carries its `fields`.
- `data_write({ op: "upsert_rows", key_column })` upserts dataset rows by
  key, and `data_write({ op: "promote_row", node_id, key, record_type, mapping? })`
  turns a row into a node record.
- `data({ op: "metrics" })` returns the summary above.
- `brief` adds `business: { model, currency, record_types }` when the
  workspace is a business or defines record types. Each record type is
  compact: `fields: "mrr:money*,stage:select,champion:relation→contact"`,
  plus `stages`.
- With the admin verb: `admin({ op: "business" })` lists the full
  definitions, and `admin_write` takes `op` = `set_business`, `record_type`
  or `delete_record_type`.
