-- 0099_drop_nexos_and_integrations.sql
--
-- WHAT
--   Bcontext is now one thing: the shared memory coding agents read and write
--   (nodes, links, RAG, skills, the MCP server). Two features that grew around
--   it are removed from the code in the same change, and this drops what they
--   kept in the database:
--
--   1. Nexo / Nexos — the in-workspace agents (0077, 0096): their tables,
--      the conflicts surface, the message windows and their two RPCs, the
--      organisation's own AI keys, the `agents` rows that backed each Nexo
--      (provider `nexo`) and the grants written for them, and the
--      conversation tables (`chat_sessions` / `chat_messages`, 0001 + 0029),
--      whose only reader and writer was the Nexo chat.
--   2. Integrations with external tools — connectors and their jobs (0011,
--      0030, 0076), the meeting bot (0023), the capability gateway with its
--      OAuth, bundles, grants, reviews and invocation ledger (0031-0035,
--      0046, 0082, 0091), integration requests (0053), the connector-install
--      principals (0079) and the Vault wrappers only they used (0034).
--
-- WHAT IS KEPT, ON PURPOSE
--   - `meeting_usage_counters` and the `meeting_minutes` usage kind: history
--     the organisation usage screen still reads; nothing writes it any more.
--   - `ai_usage_events_surface_check` still admits `nexo`, `ask_nexo` and
--     `integration_setup`: those rows are spend history, and narrowing the
--     CHECK would fail on every database that has any.
--   - `skill_schedules`, ingest candidates, outbound webhooks, meetings as
--     nodes: all core, none depend on what goes here.
--
-- VAULT
--   Several of these tables held `vault:<uuid>` references. Dropping a table
--   does not fire its row triggers, so the Vault entries are deleted first,
--   explicitly, or they would outlive every reference to them.
--
-- AGENT CONNECTION POLICY
--   `update_agent_connection_policy` wrote role, scopes AND the capability
--   grant set in one transaction. It is replaced by a version without the
--   grants (and without `p_display_name`, which only named the capability
--   principal). The new one also admits `credentials:use`, which the old
--   scope list had missed since 0089 widened the column's CHECK.
--
-- Idempotent: every drop is `if exists`, every data step tolerates the
-- table being gone, so this applies the same on a fresh database and on one
-- that has run every migration before it.

begin;

-- ── 1. Vault entries referenced only by rows about to be dropped ───────────
do $$
declare
  t text;
  ids uuid[] := '{}';
  found uuid[];
begin
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  foreach t in array array[
    'public.connector_installs',
    'public.capability_connections',
    'public.capability_oauth_clients',
    'public.capability_oauth_attempts',
    'public.capability_oauth_credentials',
    'public.organization_ai_keys'
  ] loop
    if to_regclass(t) is not null then
      -- Any `vault:<uuid>` anywhere in the row: connector installs keep refs
      -- both in `secret_ref` and inside `config`.
      execute format(
        $q$select coalesce(array_agg(distinct m[1]::uuid), '{}')
           from %s r,
                lateral regexp_matches(r::text, 'vault:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'g') m$q$,
        t
      ) into found;
      ids := ids || found;
    end if;
  end loop;
  if cardinality(ids) > 0 then
    delete from vault.secrets where id = any(ids);
  end if;
end;
$$;

-- ── 2. pg_cron: the OAuth-attempt sweep (0034). 0097 already removed it;
--      repeated here, guarded the same way, so no path leaves it behind. ──
do $$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron')
     and exists (
       select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'cron' and c.relname = 'job'
     ) then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'bcontext-expire-capability-oauth-attempts';
  end if;
end;
$$;

-- ── 3. Principals that only existed for the removed features ───────────────
-- Each Nexo was an `agents` row (provider `nexo`) with a workspace grant.
-- `workspace_grants.principal_id` has no FK, so its rows go by hand first.
delete from public.workspace_grants g
using public.agents a
where g.principal_kind = 'agent'
  and g.principal_id = a.id
  and a.provider = 'nexo';
delete from public.agents where provider = 'nexo';

alter table public.agents drop constraint if exists agents_provider_check;
alter table public.agents add constraint agents_provider_check
  check (provider in ('codex','claude_code','hermes','openclaw','other'));

-- `service_account` grants were the connector installs' (0079).
delete from public.workspace_grants where principal_kind = 'service_account';
alter table public.workspace_grants
  drop constraint if exists workspace_grants_principal_kind_check;
alter table public.workspace_grants
  add constraint workspace_grants_principal_kind_check
  check (principal_kind in ('user', 'agent'));
comment on column public.workspace_grants.principal_kind is 'user | agent.';

-- ── 4. Tables (policies, triggers and indexes go with them) ───────────────
-- Nexos
drop table if exists public.nexo_windows cascade;
drop table if exists public.nexo_inbox cascade;
drop table if exists public.nexo_runs cascade;
drop table if exists public.nexo_bindings cascade;
drop table if exists public.nexos cascade;
drop table if exists public.organization_ai_keys cascade;
drop table if exists public.nexo_conflicts cascade;
drop table if exists public.chat_messages cascade;
drop table if exists public.chat_sessions cascade;

-- Capability gateway
drop table if exists public.capability_oauth_credentials cascade;
drop table if exists public.capability_oauth_attempts cascade;
drop table if exists public.capability_oauth_clients cascade;
drop table if exists public.capability_reviews cascade;
drop table if exists public.capability_invocations cascade;
drop table if exists public.capability_rate_buckets cascade;
drop table if exists public.capability_runtime_state cascade;
drop table if exists public.capability_grants cascade;
drop table if exists public.capability_bundle_items cascade;
drop table if exists public.capability_bundle_versions cascade;
drop table if exists public.capability_bundles cascade;
drop table if exists public.capability_connections cascade;
drop table if exists public.capability_versions cascade;
drop table if exists public.capabilities cascade;
drop table if exists public.capability_principals cascade;

-- Connectors, meeting bot, integration requests
drop table if exists public.integration_request_supporters cascade;
drop table if exists public.integration_requests cascade;
drop table if exists public.meeting_bots cascade;
drop table if exists public.connector_jobs cascade;
drop table if exists public.connector_installs cascade;

-- ── 5. Indexes on kept tables that only served the removed features ───────
-- Upsert key for connector-synced nodes (0011); nothing upserts by it now.
drop index if exists public.nodes_source_external_id_idx;
-- Per-Nexo spend lookups (0096).
drop index if exists public.ai_usage_events_nexo_idx;

-- ── 6. Functions (every overload, by name) ────────────────────────────────
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        -- Nexos
        'append_nexo_window_event',
        'claim_due_nexo_windows',
        'bump_chat_session_updated_at',
        -- Capability gateway
        'consume_capability_rate_limit',
        'create_secret_or_update',
        'read_vault_secret',
        'delete_vault_secret',
        'expire_capability_oauth_attempts',
        'delete_oauth_vault_secret_on_row_delete',
        'attach_capability_oauth_credential',
        'register_capability_with_oauth',
        'validate_active_capability_grant',
        'validate_capability_bundle_current_version',
        'protect_current_bundle_items',
        'protect_current_bundle_capability',
        'update_capability_provider',
        'remove_capability_provider',
        -- Replaced below without the capability grants.
        'update_agent_connection_policy'
      )
  loop
    execute format('drop function if exists %s cascade', fn.signature);
  end loop;
end;
$$;

-- ── 7. The agent connection policy, without capability grants ─────────────
-- Role and scopes for one workspace, then every live token of the agent
-- re-scoped to the intersection of all its workspace policies — one
-- transaction, the agent's access row locked, so two edits cannot interleave.
create or replace function public.update_agent_connection_policy(
  p_workspace_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_role text,
  p_scopes text[]
)
returns table (effective_scopes text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective_scopes text[] := '{}'::text[];
begin
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'connection_admin_required';
  end if;
  if p_role not in ('observer', 'collaborator', 'operator', 'custom')
     or p_scopes is null
     or pg_catalog.cardinality(p_scopes) not between 1 and 8
     or pg_catalog.array_position(p_scopes, null) is not null
     or not (p_scopes <@ array[
       'nodes:read','nodes:write','chat:run','skills:execute',
       'agents:read','agents:write','credentials:use','admin:*'
     ]::text[]) then
    raise exception using errcode = '22023', message = 'connection_policy_input_invalid';
  end if;

  perform awa.agent_id
  from public.agent_workspace_access awa
  join public.agents a on a.id = awa.agent_id
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null
    and a.status = 'active'
  for update of awa, a;
  if not found then
    raise exception using errcode = 'P0002', message = 'agent_connection_not_found';
  end if;

  update public.agent_workspace_access awa
  set role = p_role, scopes = p_scopes
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null;
  if not found then
    raise exception using errcode = '40001', message = 'agent_connection_update_raced';
  end if;

  select coalesce(pg_catalog.array_agg(allowed.scope order by allowed.ordinality), '{}'::text[])
    into v_effective_scopes
  from pg_catalog.unnest(array[
    'nodes:read','nodes:write','chat:run','skills:execute',
    'agents:read','agents:write','credentials:use','admin:*'
  ]::text[]) with ordinality as allowed(scope, ordinality)
  where not exists (
    select 1
    from public.agent_workspace_access policy
    where policy.agent_id = p_agent_id
      and policy.revoked_at is null
      and not (allowed.scope = any(policy.scopes))
  );

  update public.api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.oauth_access_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.user_api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;

  return query select v_effective_scopes;
end;
$$;

revoke all on function public.update_agent_connection_policy(
  uuid, uuid, uuid, text, text[]
) from public, anon, authenticated;
grant execute on function public.update_agent_connection_policy(
  uuid, uuid, uuid, text, text[]
) to service_role;

commit;
