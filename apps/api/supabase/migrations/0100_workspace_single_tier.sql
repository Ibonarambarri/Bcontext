-- 0100_workspace_single_tier.sql
--
-- WHAT
--   The workspace becomes the single top-level entity. Organizations (one
--   tier above workspaces since 0016/0067) go away; this migration moves
--   everything that has to survive them down to the workspace, and 0101
--   drops them. Split in two so a failure here leaves the old model intact
--   and readable.
--
--   1. `workspace_legacy_refs` records every `<org>/<workspace>` pair that
--      exists today, so old addresses keep resolving: web `/w/<org>/<ws>`
--      redirects, MCP `/mcp/<org>/<ws>` is served as an alias, and an OAuth
--      grant bound to the old resource URL still matches its workspace.
--   2. Workspace slugs become unique across the instance (they were unique
--      per organization). Where two organizations used the same slug, the
--      oldest workspace keeps it and every other one is renamed, in a fixed
--      order, to `<org>-<slug>` (then `-2`, `-3`… if that is taken too).
--      The old pair stays in `workspace_legacy_refs`, so nothing anybody
--      wrote down breaks. Each rename is raised as a WARNING, so it shows in
--      `docker compose logs migrate` (which hides notices).
--   3. Organization owners and admins reached every workspace of their
--      organization without a membership row (`orgAdminRole` in the API).
--      They get the membership they implicitly had, with the same role, so
--      nobody loses access. An existing membership is left as it is — it
--      already won over the organization role before. Organization editors
--      and viewers held nothing by that role, so nothing is written for them.
--   4. Invitations made at organization level (no `workspace_id`) are pointed
--      at one workspace: the first of the workspaces it selected, else — for
--      owner/admin invitations, which reached all of them — the oldest
--      workspace of the organization. An editor/viewer invitation that
--      selected no workspace gave access to nothing and is deleted.
--   5. `invite_user_state(email)` replaces `waitlist_invite_user_state`
--      (same body; the waitlist it was named after is dropped in 0101).
--   6. `admin_ai_spend` is summed per workspace instead of per organization.
--
-- MUST NOT BREAK
--   Applies on a fresh database (no organizations, nothing to move) and on a
--   production one. Every step that reads organizations is guarded, so it is
--   also a no-op once 0101 has dropped them.

begin;

-- ---------------------------------------------------------------------------
-- 1. Legacy addresses
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_legacy_refs (
  -- `<org>/<workspace>`, lowercase: the pair as it was addressed before 0100.
  legacy_ref   text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at   timestamptz not null default now()
);

create index if not exists workspace_legacy_refs_workspace_idx
  on public.workspace_legacy_refs (workspace_id);

-- Read by the API with the service role only. No policy: nothing a browser
-- needs, and an anonymous read would list every workspace's old address.
alter table public.workspace_legacy_refs enable row level security;

comment on table public.workspace_legacy_refs is
  'Old <org>/<workspace> addresses from before organizations were removed (0100), mapped to the workspace they named. Read by the API to keep /w/<org>/<ws>, /mcp/<org>/<ws> and OAuth resources bound to them working. Append-only history.';

do $$
begin
  if to_regclass('public.organizations') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'workspaces'
          and column_name = 'organization_id'
     ) then
    return;
  end if;

  insert into public.workspace_legacy_refs (legacy_ref, workspace_id)
  select lower(o.slug) || '/' || lower(w.slug), w.id
    from public.workspaces w
    join public.organizations o on o.id = w.organization_id
  on conflict (legacy_ref) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Globally unique slugs
-- ---------------------------------------------------------------------------

do $$
declare
  r         record;
  base      text;
  candidate text;
  n         integer;
begin
  if to_regclass('public.organizations') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'workspaces'
          and column_name = 'organization_id'
     ) then
    return;
  end if;

  -- Ranked once, before any rename, so the order is a property of the data
  -- and not of the loop: the oldest workspace of each slug keeps it.
  for r in
    select ranked.id, ranked.slug, ranked.org_slug
      from (
        select w.id, w.slug, lower(o.slug) as org_slug,
               row_number() over (
                 partition by w.slug
                 order by w.created_at asc nulls first, w.id
               ) as rn
          from public.workspaces w
          join public.organizations o on o.id = w.organization_id
      ) ranked
     where ranked.rn > 1
     order by ranked.slug, ranked.rn
  loop
    base := rtrim(left(r.org_slug || '-' || r.slug, 80), '-');
    candidate := base;
    n := 2;
    while exists (select 1 from public.workspaces where slug = candidate) loop
      candidate := rtrim(left(base, 80 - length('-' || n)), '-') || '-' || n;
      n := n + 1;
    end loop;
    update public.workspaces set slug = candidate where id = r.id;
    raise warning 'workspace %: slug % renamed to % (was %/%)',
      r.id, r.slug, candidate, r.org_slug, r.slug;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Organization owners/admins keep the access their role gave them
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.organization_memberships') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'workspaces'
          and column_name = 'organization_id'
     ) then
    return;
  end if;

  insert into public.memberships (user_id, workspace_id, role)
  select om.user_id, w.id, om.role
    from public.organization_memberships om
    join public.workspaces w on w.organization_id = om.organization_id
   where om.role in ('owner', 'admin')
  on conflict (user_id, workspace_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Every invitation leads to one workspace
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'workspace_invites'
       and column_name = 'organization_id'
  ) then
    return;
  end if;

  update public.workspace_invites i
     set workspace_id = coalesce(
           (select w.id
              from unnest(coalesce(i.workspace_ids, '{}'::uuid[])) with ordinality as sel(id, ord)
              join public.workspaces w
                on w.id = sel.id and w.organization_id = i.organization_id
             order by sel.ord
             limit 1),
           case when i.role in ('owner', 'admin') then
             (select w.id
                from public.workspaces w
               where w.organization_id = i.organization_id
               order by w.created_at asc nulls first, w.id
               limit 1)
           end
         )
   where i.workspace_id is null;

  delete from public.workspace_invites where workspace_id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Email → account state, under a name that is not the waitlist's
-- ---------------------------------------------------------------------------

-- Same answer `waitlist_invite_user_state` gave (0020): the account's id and
-- whether it finished signing up. Invitations ask it to decide between
-- "create the account" and "sign in to accept".
create or replace function public.invite_user_state(p_email text)
returns table (user_id uuid, state text)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return query
  select
    u.id,
    case
      when coalesce((u.raw_user_meta_data->>'signup_complete')::boolean, false)
        then 'confirmed'
      else 'pending'
    end as state
    from auth.users u
   where lower(u.email) = lower(p_email)
   limit 1;
end;
$$;

revoke all on function public.invite_user_state(text) from public, anon, authenticated;
grant execute on function public.invite_user_state(text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. AI spend per workspace
-- ---------------------------------------------------------------------------

-- The result column changes name (organization_id → workspace_id), which
-- `create or replace` refuses; the old function goes first.
drop function if exists public.admin_ai_spend(timestamptz, timestamptz, uuid[]);

create function public.admin_ai_spend(
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_workspace_ids uuid[] default null
)
returns table (
  workspace_id uuid,
  events bigint,
  cost_usd numeric,
  unpriced_events bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.workspace_id,
    count(*)::bigint,
    coalesce(sum(e.cost_usd), 0)::numeric,
    count(*) filter (
      where e.cost_usd = 0
        and e.cost_source = 'fallback'
        and (e.tokens_input + e.tokens_output) > 0
    )::bigint
  from public.ai_usage_events e
  where e.workspace_id is not null
    and (p_since is null or e.created_at >= p_since)
    and (p_until is null or e.created_at < p_until)
    and (p_workspace_ids is null or e.workspace_id = any(p_workspace_ids))
  group by e.workspace_id;
$$;

comment on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) is
  'AI spend per workspace from ai_usage_events: calls, USD, and zero-cost calls that used tokens (a model with no price). Instance admin panel only.';

revoke all on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) to service_role;

commit;
