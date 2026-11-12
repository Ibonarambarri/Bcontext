-- 0101_drop_organizations.sql
--
-- WHAT
--   Drops the organization tier and the commercial machinery that hung off
--   it, now that 0100 has moved what survives down to the workspace.
--
--   Organizations
--     - `workspace_invites`: `organization_id` and `workspace_ids` go,
--       `workspace_id` becomes NOT NULL (0100 gave every row one), its
--       indexes are rebuilt on the workspace and its RLS policy asks
--       `is_workspace_admin` instead of `is_org_admin`.
--     - `workspaces`: `organization_id` and the per-workspace quotas
--       (`custom_node_limit`, `custom_meeting_hours`) go; the slug becomes
--       unique on its own (0100 removed the collisions).
--     - `error_events.organization_id` goes, and `record_error_event` stops
--       writing it (a reporter that still sends the field is ignored: the
--       payload is jsonb and the key is simply never read).
--     - `organization_memberships`, `organizations`, `is_org_member`,
--       `is_org_admin` and their policies.
--   Commercial leftovers (Bcontext is self-hosted; there is nothing to sell)
--     - plans and credits: `plans`, `organization_credits`,
--       `organization_credit_grants`, `grant_org_credit`,
--       `spend_org_credit_from_usage`;
--     - member limits and org meters: `organization_member_limits`,
--       `org_usage_counters`, `increment_org_usage`;
--     - sign-up approval and waitlist: `organization_requests`,
--       `organization_requests_account_state`, `waitlist`,
--       `record_waitlist_signup`, the waitlist triggers' functions and
--       `waitlist_invite_user_state` (replaced by `invite_user_state`, 0100);
--     - billing archives and dead counters: `workspaces_billing_legacy`,
--       `usage_counters` (0009, never read), and the 0026 billing tables if a
--       database still has them.
--
-- WHAT IS KEPT, ON PURPOSE
--   - `memberships` + `workspace_grants`: the workspace-level model, already
--     authoritative; nothing about them changes here.
--   - `mcp_usage_counters`, `meeting_usage_counters`, `ai_usage_events`:
--     per-workspace observability the usage screen reads.
--   - `account_state_for_email` (0087): generic, the sign-up path uses it.
--
-- MUST NOT BREAK
--   Every drop is `if exists`, so the file applies on a fresh database, on
--   production, and on anything in between.

begin;

-- ---------------------------------------------------------------------------
-- Invitations: one workspace each, administered by the workspace
-- ---------------------------------------------------------------------------

drop policy if exists workspace_invites_admin_all on public.workspace_invites;

alter table public.workspace_invites
  drop constraint if exists workspace_invites_verbs_need_workspace;

drop index if exists public.workspace_invites_org_idx;
drop index if exists public.workspace_invites_agent_rate_idx;
drop index if exists public.workspace_invites_delivery_idx;

-- 0100 pointed or deleted every row without a workspace; this catches one
-- written in between by an old API process still running during a deploy.
delete from public.workspace_invites where workspace_id is null;

alter table public.workspace_invites
  drop column if exists organization_id,
  drop column if exists workspace_ids;

alter table public.workspace_invites
  alter column workspace_id set not null;

create index if not exists workspace_invites_workspace_idx
  on public.workspace_invites (workspace_id);
-- The agent invitation rate limit counts per workspace per window.
create index if not exists workspace_invites_agent_rate_idx
  on public.workspace_invites (workspace_id, created_at)
  where invited_by_kind = 'agent';
create index if not exists workspace_invites_delivery_idx
  on public.workspace_invites (workspace_id, delivery_state)
  where accepted_at is null;

create policy workspace_invites_admin_all on public.workspace_invites
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

comment on table public.workspace_invites is
  'An invitation to one workspace, with a role (and optionally verbs and reach). Accepting it writes the membership and the grant.';

-- ---------------------------------------------------------------------------
-- Workspaces: top level, slug unique across the instance
-- ---------------------------------------------------------------------------

alter table public.workspaces
  drop constraint if exists workspaces_organization_id_slug_key;

alter table public.workspaces
  drop column if exists organization_id,
  drop column if exists custom_node_limit,
  drop column if exists custom_meeting_hours;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.workspaces'::regclass
       and conname = 'workspaces_slug_key'
  ) then
    alter table public.workspaces add constraint workspaces_slug_key unique (slug);
  end if;
end;
$$;

-- The unique constraint's index serves every lookup the plain one did.
drop index if exists public.workspaces_slug_idx;

comment on table public.workspaces is
  'A workspace: the top-level entity. Members (memberships + workspace_grants), agents, invitations and all content belong to one.';
comment on column public.workspaces.slug is
  'The workspace''s address, unique across the instance: /w/<slug>, /mcp/<slug>, ?workspace=<slug>. Generated from the name (lowercase + dashes, numeric suffix on collision) and immutable once created; renaming changes name, never slug. Pre-0100 <org>/<workspace> addresses resolve through workspace_legacy_refs.';

-- ---------------------------------------------------------------------------
-- Error telemetry: no organization on the event
-- ---------------------------------------------------------------------------

create or replace function public.record_error_event(
  p_fingerprint text,
  p_event jsonb,
  p_sample_cap integer default 5
)
returns table (group_id uuid, stored boolean, event_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group      public.error_groups%rowtype;
  v_now        timestamptz := now();
  v_window     timestamptz := date_trunc('minute', v_now);
  v_user       uuid := nullif(p_event->>'user_id','')::uuid;
  v_service    text := coalesce(p_event->>'service','api');
  v_operation  text := coalesce(p_event->>'operation','unknown');
  v_level      text := coalesce(p_event->>'level','error');
  v_message    text := coalesce(p_event->>'message','(no message)');
  v_release    text := nullif(p_event->>'release','');
  v_stored     boolean := false;
begin
  -- Alta o actualización del grupo. `on conflict` sobre el fingerprint es lo
  -- que hace que dos colectores concurrentes converjan en una sola fila.
  insert into public.error_groups as g (
    fingerprint, service, operation, level, error_type, message,
    first_seen, last_seen, event_count,
    users_seen, users_affected,
    first_release, last_release,
    sample_window, sample_count
  )
  values (
    p_fingerprint, v_service, v_operation, v_level,
    nullif(p_event->>'error_type',''), v_message,
    v_now, v_now, 1,
    case when v_user is null then '{}'::uuid[] else array[v_user] end,
    case when v_user is null then 0 else 1 end,
    v_release, v_release,
    v_window, 1
  )
  on conflict (fingerprint) do update set
    -- El titular es siempre el del último evento: es el que se lee primero.
    message      = v_message,
    level        = v_level,
    last_seen    = v_now,
    last_release = coalesce(v_release, g.last_release),
    event_count  = g.event_count + 1,
    -- Un problema dado por resuelto que vuelve a ocurrir se reabre. Es
    -- justo lo que un listado de "resueltos" no puede ocultar: un arreglo
    -- que no aguantó. `ignored` no se reabre — ignorar es una decisión sobre
    -- el futuro, no sobre el pasado.
    status = case
               when g.status = 'resolved' then 'new'
               else g.status
             end,
    resolved_at = case when g.status = 'resolved' then null else g.resolved_at end,
    users_seen = case
                   when v_user is null or v_user = any(g.users_seen) then g.users_seen
                   when array_length(g.users_seen, 1) >= 50 then g.users_seen
                   else g.users_seen || v_user
                 end,
    users_affected = case
                       when v_user is null or v_user = any(g.users_seen) then g.users_affected
                       when array_length(g.users_seen, 1) >= 50 then g.users_affected
                       else g.users_affected + 1
                     end,
    -- Ventana de muestreo: si cambió el minuto se reinicia el cupo.
    sample_window = case when g.sample_window < v_window then v_window else g.sample_window end,
    sample_count  = case when g.sample_window < v_window then 1 else g.sample_count + 1 end,
    updated_at = v_now
  returning * into v_group;

  -- ¿Cabe la fila? El cupo se mira DESPUÉS del upsert porque el upsert es
  -- quien ya lo ha incrementado: `sample_count <= cap` es "esta ocurrencia
  -- es una de las primeras `cap` del minuto".
  if v_group.sample_count <= greatest(p_sample_cap, 1) then
    insert into public.error_events (
      group_id, received_at, occurred_at,
      service, operation, level, error_type, message, stack, cause,
      release, environment, instance,
      user_id, workspace_id, actor_type, token_id,
      request_id, correlation_id, method, path, status_code, duration_ms,
      user_agent, url, job_id, job_name, attempt, context
    )
    values (
      v_group.id, v_now, nullif(p_event->>'occurred_at','')::timestamptz,
      v_service, v_operation, v_level,
      nullif(p_event->>'error_type',''), v_message,
      nullif(p_event->>'stack',''), nullif(p_event->>'cause',''),
      v_release, nullif(p_event->>'environment',''), nullif(p_event->>'instance',''),
      v_user,
      nullif(p_event->>'workspace_id','')::uuid,
      nullif(p_event->>'actor_type',''),
      nullif(p_event->>'token_id',''),
      nullif(p_event->>'request_id',''),
      nullif(p_event->>'correlation_id',''),
      nullif(p_event->>'method',''),
      nullif(p_event->>'path',''),
      nullif(p_event->>'status_code','')::integer,
      nullif(p_event->>'duration_ms','')::integer,
      nullif(p_event->>'user_agent',''),
      nullif(p_event->>'url',''),
      nullif(p_event->>'job_id',''),
      nullif(p_event->>'job_name',''),
      nullif(p_event->>'attempt','')::integer,
      case when p_event ? 'context' then p_event->'context' else null end
    );
    v_stored := true;
  end if;

  return query select v_group.id, v_stored, v_group.event_count;
end;
$$;

alter table public.error_events drop column if exists organization_id;

-- ---------------------------------------------------------------------------
-- Commercial leftovers
-- ---------------------------------------------------------------------------

-- The waitlist triggers lived on auth.users (0018/0019). Dropped only when
-- present: auth.users belongs to the Auth service, and asking to drop a
-- trigger that is not there would still need its ownership.
do $$
declare
  t record;
begin
  for t in
    select tg.tgname
      from pg_catalog.pg_trigger tg
     where tg.tgrelid = 'auth.users'::regclass
       and not tg.tgisinternal
       and tg.tgname in ('waitlist_mark_accepted_on_signup', 'waitlist_mark_accepted_on_password')
  loop
    execute format('drop trigger if exists %I on auth.users', t.tgname);
  end loop;
end;
$$;

drop trigger if exists ai_usage_events_spend_credit on public.ai_usage_events;

drop table if exists public.organization_requests cascade;
drop table if exists public.waitlist cascade;
drop table if exists public.organization_credit_grants cascade;
drop table if exists public.organization_credits cascade;
drop table if exists public.organization_member_limits cascade;
drop table if exists public.org_usage_counters cascade;
drop table if exists public.workspaces_billing_legacy cascade;
drop table if exists public.usage_counters cascade;
drop table if exists public.company_member_entitlements cascade;
drop table if exists public.account_usage_counters cascade;
drop table if exists public.user_account_plans cascade;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------

-- Their own policies go with the tables; the one policy elsewhere that
-- called `is_org_admin` (workspace_invites) was replaced above.
drop table if exists public.organization_memberships cascade;
-- `organizations.plan` references `plans`, and 0026's `billing_accounts` was
-- referenced from `organizations`: both go after it.
drop table if exists public.organizations cascade;
drop table if exists public.plans cascade;
drop table if exists public.billing_accounts cascade;

-- Every overload of every function that only served the above.
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
         'is_org_member',
         'is_org_admin',
         'grant_org_credit',
         'spend_org_credit_from_usage',
         'increment_org_usage',
         'record_waitlist_signup',
         'waitlist_mark_accepted',
         'waitlist_mark_accepted_on_password',
         'waitlist_invite_user_state',
         'organization_requests_account_state'
       )
  loop
    execute format('drop function if exists %s cascade', fn.signature);
  end loop;
end;
$$;

commit;
