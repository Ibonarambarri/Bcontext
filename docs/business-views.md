# Business views and templates

Once a workspace has record types and business events
([ingest-api.md](ingest-api.md)), saved views show them: a deal pipeline
grouped by stage, a renewals table, KPI cards, a supply-vs-demand heatmap.
Agents write the records; the web is for reading them fast. The only edits it
makes are light ones: dragging a card between stages, or converting a dataset
row into a node.

## Views over record types

A view's `query` names record kinds like any other kind, and can filter on
their fields. The `presentation` names a field anywhere it names a column,
as `field:<key>`.

```json
{
  "query": {
    "schema_version": 1,
    "kinds": ["deal"],
    "field_filters": [{ "field": "close_date", "op": "empty", "value": false }]
  },
  "presentation": {
    "schema_version": 1,
    "renderer": "board",
    "group_by": "field:stage",
    "sort_by": [{ "field": "field:amount", "direction": "desc" }],
    "columns": ["title", "field:amount", "field:account"],
    "layout": { "board": { "total_field": "amount", "total_suffix": "/mo" } }
  }
}
```

- `field_filters` take `eq`, `in`, `gt`, `lt` and `empty`. Money compares on
  its amount, and dates compare as ISO strings. `empty: true` keeps records
  with no value, and `empty: false` keeps the ones that have one.
- **Board** (`renderer: "board"`): `group_by: "field:<key>"` names a select,
  person or boolean field. If you leave it out, the board groups by the
  record type's `stage_field`. Columns follow the field's options in order.
  Each column header gives the count and the sum of `layout.board.total_field`
  (otherwise the first money or number field), for example
  `Proposal · 3 · €2,100/mo`. Dragging a card sends
  `PATCH /api/nodes/:id { fields: { stage: "won" } }`, which the record type
  validates. A refused move snaps back and shows the API's message.
- **Table** (`table` or `list`): the `columns` are formatted by type. Money
  shows with its currency, dates as dates, selects as chips, and relations
  as links that open the node. The footer sums every money and number column
  and never adds two currencies together.
- **Dataset-backed types** (`query.dataset_type: "customer"`): the view lists
  the dataset's keyed rows (up to 1,000; the rest stays queryable through
  `data(op=query)`). Each row has a **Convert to …** action, which calls
  `POST /api/nodes/:dataset/dataset/promote { workspace, key, record_type }`.
  The best-matching node record type is the default target. Promoting the
  same row again updates the node it already made.

A field, a dataset type or a layout the workspace doesn't have is refused
when the view is saved, with a 400 that names the fields that exist. A
stored view whose field was later removed still opens; that column is just
empty.

## Metrics and heatmaps

Both renderers keep their configuration in `presentation.layout`. They read
an **aggregate**: business events or a dataset-backed type's rows, grouped
by a date bucketed by day, week or month, plus an optional second dimension.

```json
{
  "source": { "from": "events", "types": ["booking.created"] },
  "x": { "key": "occurred_at", "bucket": "week" },
  "y": { "key": "zone" },
  "measures": [
    { "as": "bookings", "op": "count" },
    { "as": "suppliers", "op": "count_distinct", "key": "supplier_id" }
  ],
  "since": "2025-01-01"
}
```

For events, a key is an event column (`occurred_at`, `subject_id`, `amount`,
`type`) or a property (`zone`, `supplier_id`). `count_distinct` works only
on events. A sum of `amount` counts only events in the reporting currency.

- **`metrics`**: `layout.metrics = { kpis?, compare: "previous" | "year_ago", charts }`.
  The cards come from the metrics summary. Each shows its value, the change
  against the previous month (or the same month last year), and a 12-month
  sparkline. Each chart takes either `kpis` (summary series) or an
  `aggregate` with a bucketed `x`. `yoy: true` adds the same bucket a year
  earlier as a dashed line. Weeks align on weekdays (52 weeks back), so a
  marketplace with seasonal demand compares like with like.
- **`heatmap`**: `layout.heatmap = { aggregate, value, second?, color_by: "value" | "ratio", high_is: "good" | "bad" }`.
  The heatmap is an x × y grid. Each cell shows `value` and, below it,
  `second`, and is coloured by the value or by value ÷ second. An empty pair
  is drawn empty, not as 0.

`POST /api/views/:id/resolve` returns these alongside the node ids:
`records` (record types and rows with fields), `dataset`, `metrics`
(`summary` and `charts[]`) and `heatmap`. MCP `views(op=resolve)` returns the
same, so an agent quotes the numbers the team sees.

## Templates per business model

| Model | Record types | Views |
|---|---|---|
| `b2b` | `account` (status, plan, mrr, health, renewal_date, owner, seats, website), `contact` (account, role, email, decision_maker), `deal` (stage lead → demo → proposal → negotiation → won/lost, amount, probability, account, close_date, owner), `request` (status requested → planned → in_progress → shipped/declined, weight, accounts, segment, source) | Pipeline, Accounts, Renewals, Requests, Metrics, Expenses |
| `b2c` | `segment`, `request` (→ segments), `incident` (→ segments), dataset-backed `customer` (name, email, plan, status, mrr, signup_date, country) | Customers, Requests, Metrics, Expenses |
| `marketplace` | `segment`, `zone` (zone_code, region, status, demand, active_suppliers), `incident` (→ zone), `request` (→ segments, side), dataset-backed `supplier` and `buyer` | Marketplace metrics (YoY), Supply vs demand (zone × week heatmap), Suppliers, Incidents, Requests, Expenses |
| `product` | none | none |

Templates are defaults. Rename `supplier` to "Instructors" and `buyer` to
"Clients", add fields, or delete a view you don't use. Applying a template
is **additive and idempotent**:

- A record type whose key exists is skipped, even if its fields differ.
- A view is skipped if one already carries its marker
  (`presentation.layout.template = "<model>:<key>"`) or has the slug of its
  name.
- A dataset-backed type reuses a `data` node it created on an earlier run.
- Nothing is overwritten or deleted. A template view whose fields a kept
  type no longer has is reported in `skipped` instead of being created.

There are three ways to apply a template:

```bash
# Preview: what would be created and what would be skipped (read)
curl "$BCONTEXT/api/workspaces/denak/business/apply-template?business_model=b2b" -H "Cookie: <session>"
# Apply (admin); with no body it applies the workspace's own model
curl -X POST "$BCONTEXT/api/workspaces/denak/business/apply-template" \
  -H "Cookie: <session>" -H "Content-Type: application/json" -d '{"business_model":"b2b"}'
```

- Over MCP, with the admin verb: `admin_write({ op: "apply_business_template", business_model? })`.
- At creation: `POST /api/workspaces { name, business_model }` sets the
  model, applies its template and returns what it did as `business_template`.

## Timeline of one subject

A subject's events are read with `GET /api/workspaces/:ws/events?subject_type=&subject_id=`
([ingest-api.md](ingest-api.md)); the web's record 360 page draws them.
