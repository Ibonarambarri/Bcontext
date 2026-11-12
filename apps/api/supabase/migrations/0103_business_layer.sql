-- 0103_business_layer.sql
--
-- WHAT
--   The business layer: a workspace that also knows its customers, its money
--   and its usage. Six pieces, all additive:
--
--     1. workspaces.business_model (product | b2b | b2c | marketplace) and
--        workspaces.business_currency (the reporting currency of the metrics).
--     2. record_types — the kinds a workspace defines for itself (`account`,
--        `deal`, `zone`…), with their fields and optional pipeline stage.
--        A record type of storage `node` IS a node kind: `nodes.kind` now
--        accepts the core kinds plus the workspace's node record types,
--        checked by a trigger instead of the fixed CHECK list.
--     3. dataset_rows.key — a stable, caller-chosen row key, unique per
--        dataset, so rows can be upserted instead of only appended.
--     4. nodes external ids — a partial unique index on
--        (workspace_id, kind, data->>'external_id'), so a SaaS app re-sending
--        the same customer updates the same node.
--     5. business_events — append-only facts pushed by the customer's own
--        product (subscriptions, bookings, expenses, cash), idempotent per
--        workspace; and business_metric_rollups, what the worker computes
--        from them (daily and monthly grain).
--     6. ingest_keys — write-only credentials for the ingest API.
--
-- WHY A TRIGGER AND NOT A WIDER CHECK FOR nodes.kind
--   The valid set is now per workspace (core kinds ∪ that workspace's record
--   types), which a CHECK cannot express because it cannot read another
--   table. The application validates first, with an error that names the
--   kinds that do exist; this trigger is the net underneath for every path
--   nobody remembers (scripts, service-role writes), as `nodes_kind_check`
--   was. The core list is written out once here and once in the contract
--   (`NODE_KINDS`); `record-types-vocabulary-matches-db.test.ts` fails if they
--   drift.
--
-- WHY data->>'external_id' AND NOT A COLUMN
--   A record's identity outside Bcontext belongs with the rest of what the
--   record is (`data.fields`, `data.source_row`), and every read path already
--   returns `data`. A column would have to be threaded through both storage
--   backends, every select list and the node contract for one lookup that a
--   partial expression index serves just as well. The application keeps the
--   key from being lost on a `data` patch (it re-applies reserved keys).
--
-- WHY EVENTS ARE APPEND-ONLY BUT NOT IMMUTABLE
--   The amounts, types and dates of an event are facts and never change: a
--   correction is a new event. The subject link is the exception, because a
--   person may ask to be forgotten (GDPR art. 17): erasing a customer
--   replaces their `subject_id` with an opaque token, keeping the aggregates
--   right without keeping the person. The trigger below enforces exactly
--   that split.
--
-- RLS
--   Not the authorisation layer here either (every server path is
--   service-role after `openWorkspace`). record_types follows the
--   capabilities tables: members read, admins write. Events, rollups and
--   ingest keys are customer data or secrets: RLS on and no policy for
--   events and rollups (service role only, as dataset_rows in 0086); ingest
--   keys get the api_tokens policies (admins of the workspace).
--
-- MUST NOT BREAK
--   Applies on a fresh database and on one migrated to 0102. Existing
--   workspaces stay `product`; existing nodes all carry core kinds and pass
--   the new trigger; existing dataset rows keep `key = null`.

begin;

-- ── 1. Workspace business settings ─────────────────────────────────────────

alter table public.workspaces
  add column if not exists business_model text not null default 'product',
  add column if not exists business_currency text not null default 'EUR';

alter table public.workspaces drop constraint if exists workspaces_business_model_check;
alter table public.workspaces add constraint workspaces_business_model_check
  check (business_model in ('product', 'b2b', 'b2c', 'marketplace'));

alter table public.workspaces drop constraint if exists workspaces_business_currency_check;
alter table public.workspaces add constraint workspaces_business_currency_check
  check (business_currency ~ '^[A-Z]{3}$');

comment on column public.workspaces.business_model is
  'product (default: a software team, no business metrics) | b2b | b2c | marketplace. Decides which KPI set the metrics summary computes.';
comment on column public.workspaces.business_currency is
  'ISO 4217 code the business metrics are reported in. Events in another currency are stored but left out of money metrics (no FX).';

-- ── 2. Record types ─────────────────────────────────────────────────────────

create table if not exists public.record_types (
  id            uuid primary key default extensions.uuid_generate_v4(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- The kind itself (`account`). Immutable once created: nodes carry it.
  key           text not null,
  label         text not null,
  description   text,
  -- `node`: each record is a node of kind `key`. `dataset`: records are rows
  -- of the dataset node `dataset_node_id`, keyed by external id — for people
  -- in a B2C business, who are too many and too personal to be nodes.
  storage       text not null default 'node',
  dataset_node_id uuid,
  -- { fields: [...], stage_field, label_plural } — the contract's
  -- RecordTypeDefinition minus the columns above. Validated by the API with
  -- the same zod schema the web uses; only its shape is checked here.
  definition    jsonb not null default '{}'::jsonb,
  position      integer not null default 0,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint record_types_workspace_key_uniq unique (workspace_id, key),
  constraint record_types_key_format check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Same list as NODE_KINDS in packages/contract/src/types.ts.
  constraint record_types_key_not_core check (
    key <> all (array['doc','task','decision','meeting','bug','adr','entity','skill','data','credential','goal'])
  ),
  constraint record_types_storage_check check (storage in ('node', 'dataset')),
  constraint record_types_dataset_target check (
    (storage = 'dataset') = (dataset_node_id is not null)
  ),
  constraint record_types_definition_is_object check (jsonb_typeof(definition) = 'object'),
  -- The dataset must live in the same workspace (composite FK onto the pair
  -- 0086 made referenceable). Deleting the dataset node is refused while a
  -- record type points at it: dropping a customer table by deleting a node
  -- is not something to make easy.
  constraint record_types_dataset_fk foreign key (dataset_node_id, workspace_id)
    references public.nodes (id, workspace_id) on delete restrict
);

comment on table public.record_types is
  'Per-workspace record types (business layer). storage=node: a node kind; storage=dataset: rows of dataset_node_id keyed by external id.';

create index if not exists record_types_workspace_idx on public.record_types (workspace_id, position);

-- Key and storage are identity: changing either would orphan every record.
create or replace function public.record_types_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.key <> old.key or new.workspace_id <> old.workspace_id then
      raise exception 'record type key is immutable (% → %)', old.key, new.key
        using errcode = 'check_violation';
    end if;
    if new.storage <> old.storage then
      raise exception 'record type % cannot change storage', old.key
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;
  -- DELETE: refuse while nodes of this kind exist. The API says so first,
  -- with a count; this is for every other path.
  if old.storage = 'node' and exists (
    select 1 from public.nodes n
     where n.workspace_id = old.workspace_id and n.kind = old.key
  ) then
    raise exception 'record type % still has nodes; delete or convert them first', old.key
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists record_types_guard on public.record_types;
create trigger record_types_guard
  before update or delete on public.record_types
  for each row execute function public.record_types_guard();

-- nodes.kind: core kinds ∪ the workspace's node record types.
alter table public.nodes drop constraint if exists nodes_kind_check;

create or replace function public.nodes_kind_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.kind = old.kind then
    return new;
  end if;
  -- Same list as NODE_KINDS in packages/contract/src/types.ts.
  if new.kind = any (array['doc','task','decision','meeting','bug','adr','entity','skill','data','credential','goal']) then
    return new;
  end if;
  if exists (
    select 1 from public.record_types rt
     where rt.workspace_id = new.workspace_id
       and rt.key = new.kind
       and rt.storage = 'node'
  ) then
    return new;
  end if;
  raise exception 'unknown node kind % for this workspace', new.kind
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists nodes_kind_guard on public.nodes;
create trigger nodes_kind_guard
  before insert or update of kind on public.nodes
  for each row execute function public.nodes_kind_guard();

-- ── 3. Dataset row keys ─────────────────────────────────────────────────────

alter table public.dataset_rows add column if not exists key text;

alter table public.dataset_rows drop constraint if exists dataset_rows_key_format;
alter table public.dataset_rows add constraint dataset_rows_key_format
  check (key is null or (length(key) between 1 and 200));

-- Null for every row written before keys existed, and for rows appended
-- without one: positional rows stay positional.
create unique index if not exists dataset_rows_node_key_uniq
  on public.dataset_rows (node_id, key) where key is not null;

comment on column public.dataset_rows.key is
  'Stable caller-chosen key (e.g. the external id of a person). Unique per dataset; rows are upserted by it. Null for positional rows.';

-- ── 4. External ids on record nodes ─────────────────────────────────────────

create unique index if not exists nodes_workspace_kind_external_id_uniq
  on public.nodes (workspace_id, kind, (data->>'external_id'))
  where data ? 'external_id';

-- ── 5. Business events and metric rollups ───────────────────────────────────

create table if not exists public.business_events (
  id               uuid primary key default extensions.uuid_generate_v4(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  -- `subscription.started`, `booking.created`… Unknown types are stored and
  -- ignored by the rollups (the vocabulary is in the contract, not here, so
  -- adding a metric never needs a migration).
  type             text not null,
  occurred_at      timestamptz not null,
  received_at      timestamptz not null default now(),
  -- Who the event is about, by the sender's own id: an account, a buyer.
  subject_type     text,
  subject_id       text,
  -- Major units (49.90, not 4990).
  amount           numeric(20, 4),
  currency         text,
  properties       jsonb not null default '{}'::jsonb,
  -- The sender's dedupe key. A retry with the same key is a no-op.
  idempotency_key  text not null,
  ingest_key_id    uuid,
  -- Set when the subject asked to be forgotten (see header).
  subject_erased_at timestamptz,

  constraint business_events_idempotency_uniq unique (workspace_id, idempotency_key),
  constraint business_events_type_format check (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(type) <= 80),
  constraint business_events_currency_format check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint business_events_properties_is_object check (jsonb_typeof(properties) = 'object'),
  constraint business_events_key_length check (length(idempotency_key) between 1 and 200)
);

comment on table public.business_events is
  'Append-only business facts pushed through the ingest API. Facts never change (a correction is a new event); only the subject link may be erased.';

-- The rollup reads one workspace in time order; the erasure path finds a
-- subject's events.
create index if not exists business_events_workspace_time_idx
  on public.business_events (workspace_id, occurred_at);
create index if not exists business_events_workspace_subject_idx
  on public.business_events (workspace_id, subject_id) where subject_id is not null;

create or replace function public.business_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id is distinct from old.workspace_id
       or new.type is distinct from old.type
       or new.occurred_at is distinct from old.occurred_at
       or new.received_at is distinct from old.received_at
       or new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'business events are append-only: only the subject link may change'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists business_events_append_only on public.business_events;
create trigger business_events_append_only
  before update on public.business_events
  for each row execute function public.business_events_append_only();

create table if not exists public.business_metric_rollups (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- `day` for the daily series, `month` for the KPIs whose month value is
  -- not the sum of its days (distinct customers, end-of-month MRR).
  grain         text not null,
  period_start  date not null,
  metric        text not null,
  -- '' for the metric itself; a category for `expenses_by_category`.
  dimension     text not null default '',
  value         numeric(24, 6) not null,
  computed_at   timestamptz not null default now(),

  primary key (workspace_id, grain, period_start, metric, dimension),
  constraint business_metric_rollups_grain_check check (grain in ('day', 'month'))
);

comment on table public.business_metric_rollups is
  'What the business.rollup worker job computed from business_events. Derived data: safe to delete and recompute.';

-- ── 6. Ingest keys ──────────────────────────────────────────────────────────

create table if not exists public.ingest_keys (
  id            uuid primary key default extensions.uuid_generate_v4(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  -- `bctx_ingest_` + 4 chars, for the UI. The plaintext is shown once.
  prefix        text not null,
  last4         text not null,
  -- sha256(hex) of the secret suffix.
  hash          text not null unique,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

comment on table public.ingest_keys is
  'Write-only credentials for the ingest API (records, events). A distinct prefix (bctx_ingest_) that the bearer parser of every other route rejects, so a leaked key can push data and read nothing.';

create index if not exists ingest_keys_workspace_idx on public.ingest_keys (workspace_id);

alter table public.business_events
  drop constraint if exists business_events_ingest_key_fk;
alter table public.business_events
  add constraint business_events_ingest_key_fk foreign key (ingest_key_id)
  references public.ingest_keys (id) on delete set null;

-- ── 7. Row level security and privileges ────────────────────────────────────

alter table public.record_types enable row level security;
alter table public.business_events enable row level security;
alter table public.business_metric_rollups enable row level security;
alter table public.ingest_keys enable row level security;

drop policy if exists record_types_member_read on public.record_types;
create policy record_types_member_read on public.record_types
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists record_types_admin_write on public.record_types;
create policy record_types_admin_write on public.record_types
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists ingest_keys_admin_all on public.ingest_keys;
create policy ingest_keys_admin_all on public.ingest_keys
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- Stated explicitly so the result does not depend on default privileges:
-- events and rollups are service-role only; the anon role never touches any
-- of this.
revoke all on table public.business_events, public.business_metric_rollups from public, anon, authenticated;
revoke all on table public.record_types, public.ingest_keys from public, anon;
grant select on table public.record_types to authenticated;
grant select, insert, update, delete on table public.ingest_keys to authenticated;
grant all on table public.record_types, public.business_events, public.business_metric_rollups, public.ingest_keys to service_role;

revoke all on function public.record_types_guard() from public, anon, authenticated;
revoke all on function public.nodes_kind_guard() from public, anon, authenticated;
revoke all on function public.business_events_append_only() from public, anon, authenticated;

commit;
