/**
 * Workspaces, their people and their invitations, as the instance admin
 * works them (`/api/admin/workspaces/**`, `/api/admin/users/**`,
 * `/api/admin/invites/:id/email`).
 *
 * Besides self-service creation (`POST /api/workspaces`), an instance admin
 * can create a workspace here and get back a link for the person who will
 * own it. Nothing leaves the building on its own — the link is copied and
 * sent personally, or the admin asks for the email in a second, explicit act
 * (`sendAdminInviteEmail`). That asymmetry is the same one
 * `@/lib/auth/invitations` documents: an email is the only action here that
 * cannot be undone.
 *
 * Must not break: everything runs on the service-role client, so every
 * caller must have gone through `gateAdmin` first.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { inviteUrl } from "@/lib/app-url";
import { log } from "@bcontext-dev/contract/log";
import { insertWorkspace, WorkspaceCreateError } from "@/lib/workspaces/registry";
import { createWorkspaceInvite, revokeWorkspaceInvite } from "@/lib/workspaces/members";
import {
  deliverInvite,
  INVITE_COLUMNS,
  InviteDeliveryError,
  type InviteRow,
} from "@/lib/workspaces/invite-email";
import { countNodes, currentPeriod, periodStart, WRITE_VERBS } from "@/lib/workspaces/usage";
import { lastUsedByAgent, newest } from "@/lib/agents/last-used";
import {
  ADMIN_WORKSPACE_STATES,
  adminWorkspaceState,
  matchesAdminWorkspaceState,
} from "@bcontext-dev/contract/admin-workspaces";
import { pageBounds, searchTerm } from "@/lib/admin/list-params";
import {
  fetchWorkspaceAiSpend,
  NO_AI_SPEND,
  type AdminWorkspaceAiSpend,
} from "@/lib/admin/ai-spend";
import type {
  AdminInvite,
  AdminPage,
  AdminUserAgent,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserPage,
  AdminUserRow,
  AdminUserState,
  AdminUserWorkspace,
  AdminWorkspaceBase,
  AdminWorkspaceDetail,
  AdminWorkspaceHealth,
  AdminWorkspaceHealthList,
  AdminWorkspaceListQuery,
  AdminWorkspaceSummary,
  InviteEmailStatus,
} from "@bcontext-dev/contract/admin-workspaces";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";

/**
 * The list row and the detail, each with what the workspace's AI calls cost
 * (`src/lib/admin/ai-spend.ts`). The figures ride on the admin reads rather
 * than the contract because they are the operator's check that the
 * accounting works, read on one screen; `null` means the ledger could not be
 * read, which the panel prints as "unavailable" and never as $0.
 */
export type AdminWorkspaceSummaryWithSpend = AdminWorkspaceSummary & {
  ai_spend: AdminWorkspaceAiSpend | null;
};
export type AdminWorkspaceDetailWithSpend = AdminWorkspaceDetail & {
  ai_spend: AdminWorkspaceAiSpend | null;
};

export class AdminWorkspaceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AdminWorkspaceError";
  }
}

function toAdminInvite(row: InviteRow): AdminInvite {
  const state = row.delivery_state;
  const emailStatus: InviteEmailStatus | null =
    state === "sent" ? "sent" : state === "failed" ? "error" : null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    accepted_at: row.accepted_at,
    // Computed rather than left as two dates to compare, because an expiry
    // the reader has to work out is an expiry nobody checks.
    expired: !row.accepted_at && new Date(row.expires_at).getTime() < Date.now(),
    url: inviteUrl(row.token),
    expires_at: row.expires_at,
    created_at: row.created_at,
    email_status: emailStatus,
    email_sent_at: row.delivery_at,
    email_error: row.delivery_error,
  };
}

/**
 * The four roles a person can hold. `memberships.role` still admits the
 * legacy `agent` value its check constraint was written with, which nothing
 * writes any more and which is not a role a human holds; anything the panel
 * does not recognise reads as the least access rather than as more.
 */
const PERSON_ROLES: readonly InviteRole[] = ["owner", "admin", "editor", "viewer"];

function personRole(role: string): InviteRole {
  return PERSON_ROLES.includes(role as InviteRole) ? (role as InviteRole) : "viewer";
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A page of workspaces, worst first.
 *
 * THE SHAPE OF THE READ, and why `limit`/`offset` do not simply ride on one
 * query: the list is ordered by `state`, which is derived from counters
 * spread across several tables and the auth server. An ORDER BY Postgres
 * cannot express is an ORDER BY that has to happen after the fold, and a fold
 * over one page would rank page two among itself. So the sweep runs over
 * every workspace the filters left, and what `limit` and `offset` reach is
 * the expensive half: invitation rows and AI spend are read for the page's
 * workspaces and nobody else's.
 *
 * `total` is the workspaces matching the filters — what the sweep counted,
 * never the length of the page.
 */
export async function listAdminWorkspaces(
  params: AdminWorkspaceListQuery = {},
): Promise<AdminPage<AdminWorkspaceSummaryWithSpend>> {
  const { limit, offset } = pageBounds(params);
  const rows = await sweepWorkspaceHealth({ q: params.q });
  const state = params.state;
  const matched = state
    ? rows.filter((row) => matchesAdminWorkspaceState(row.state, state))
    : rows;
  matched.sort(worstFirst);

  const page = matched.slice(offset, offset + limit);
  const pageIds = page.map((row) => row.id);
  const [invites, spend] = await Promise.all([
    pendingInvitesByWorkspace(pageIds),
    fetchWorkspaceAiSpend(pageIds),
  ]);
  return {
    items: page.map((row) => ({
      ...toSummary(row, invites.get(row.id) ?? []),
      ai_spend: spend.available ? (spend.byWorkspace.get(row.id) ?? NO_AI_SPEND) : null,
    })),
    total: matched.length,
    limit,
    offset,
  };
}

/**
 * The ladder first, then age. Two workspaces stuck on the same rung are read
 * oldest-problem-first: one that has sat unopened since March is a worse fact
 * than one that has sat unopened since Tuesday.
 */
function worstFirst(a: HealthRow, b: HealthRow): number {
  const rank =
    ADMIN_WORKSPACE_STATES.indexOf(a.state) - ADMIN_WORKSPACE_STATES.indexOf(b.state);
  return rank !== 0 ? rank : a.created_at < b.created_at ? -1 : 1;
}

function toSummary(row: HealthRow, pendingInvites: AdminInvite[]): AdminWorkspaceSummary {
  const { owner_emails, owner_email: _owner, ...health } = row;
  return { ...health, owner_emails, pending_invites: pendingInvites };
}

/**
 * The open invitations of the workspaces on this page, whole rows. The link
 * *is* the act — an operator who has just created a workspace copies it from
 * the row — so it travels with the list rather than behind a detail request.
 */
async function pendingInvitesByWorkspace(
  workspaceIds: string[],
): Promise<Map<string, AdminInvite[]>> {
  const out = new Map<string, AdminInvite[]>();
  if (workspaceIds.length === 0) return out;
  const { data } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .in("workspace_id", workspaceIds)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });
  for (const row of (data ?? []) as InviteRow[]) {
    const list = out.get(row.workspace_id) ?? [];
    list.push(toAdminInvite(row));
    out.set(row.workspace_id, list);
  }
  return out;
}

export async function getAdminWorkspaceDetail(id: string): Promise<AdminWorkspaceDetailWithSpend> {
  const admin = getSupabaseAdmin();
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, slug, name, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!ws) throw new AdminWorkspaceError(404, "not_found");

  const [{ data: memberships }, { data: invites }] = await Promise.all([
    admin
      .from("memberships")
      .select("user_id, role, created_at")
      .eq("workspace_id", id)
      .neq("role", "agent"),
    // Accepted invitations stay in the list: an invitation that disappears
    // the moment it is used leaves no record of what was sent to whom, which
    // is the only account of how this workspace came to have its people.
    admin
      .from("workspace_invites")
      .select(INVITE_COLUMNS)
      .eq("workspace_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const rows = (memberships ?? []) as Array<{
    user_id: string;
    role: string;
    created_at: string | null;
  }>;
  const [people, nodeCounts, lastActivity, spend] = await Promise.all([
    usersForIds(rows.map((m) => m.user_id)),
    countNodes([id]),
    lastActivityByWorkspace([id]),
    fetchWorkspaceAiSpend([id]),
  ]);

  const allInvites = ((invites ?? []) as InviteRow[]).map(toAdminInvite);
  // Open means unaccepted, expired included: an invitation nobody took and
  // that has now run out is still an open thread with a person, and it is the
  // one the operator most needs to see. Same rule as the list read.
  const pendingInvites = allInvites.filter((i) => !i.accepted_at);

  return {
    id: ws.id as string,
    slug: ws.slug as string,
    name: ws.name as string,
    created_at: ws.created_at as string,
    member_count: rows.length,
    pending_invite_count: pendingInvites.length,
    owner_emails: rows
      .filter((m) => m.role === "owner")
      .map((m) => people.get(m.user_id)?.email ?? null)
      .filter((e): e is string => Boolean(e)),
    members: rows.map((m) => ({
      user_id: m.user_id,
      email: people.get(m.user_id)?.email ?? null,
      role: personRole(m.role),
      joined_at: m.created_at,
      confirmed: people.get(m.user_id)?.confirmed ?? false,
      last_sign_in_at: people.get(m.user_id)?.last_sign_in_at ?? null,
    })),
    pending_invites: pendingInvites,
    invites: allInvites,
    node_count: nodeCounts.get(id) ?? 0,
    last_activity_at: lastActivity.get(id) ?? null,
    ai_spend: spend.available ? (spend.byWorkspace.get(id) ?? NO_AI_SPEND) : null,
  };
}

/**
 * The furthest the people list can see. The auth server hands its accounts
 * out in pages of 200 and offers neither a search nor a join, so the walk is
 * the query and the cap is where it stops.
 */
const AUTH_PAGE = 200;
const AUTH_SCAN_CAP = 1000;

/**
 * A page of people, and how far the answer reached.
 *
 * Accounts live in the auth server, not in a table this can join or filter,
 * and the people this screen exists to find are the ones onboarding lost:
 * invited, never signed in, and often in no workspace at all, because the
 * membership is written when the invitation is *accepted*. A list built on
 * memberships could not show them. So: one walk of the accounts, bounded at
 * `AUTH_SCAN_CAP`; the filters applied to what it saw; `scanned`, `cap` and
 * `capped` saying out loud when the answer is a smaller question than the
 * one asked.
 */
export async function listAdminUsers(
  params: AdminUserListQuery = {},
): Promise<AdminUserPage> {
  const { limit, offset } = pageBounds(params);
  const admin = getSupabaseAdmin();
  const users: AdminUserRow[] = [];
  for (let page = 1; page * AUTH_PAGE <= AUTH_SCAN_CAP; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_PAGE,
    });
    if (error) throw new Error(`listAdminUsers: ${error.message}`);
    const batch = data?.users ?? [];
    for (const u of batch) {
      users.push({
        id: u.id,
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        // An invited person who never set a password has no confirmation.
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
        workspaces: [],
      });
    }
    if (batch.length < AUTH_PAGE) break;
  }

  const { data: memberships } = await admin
    .from("memberships")
    .select("user_id, role, workspace:workspaces!inner(id, slug, name)")
    .neq("role", "agent");
  const byUser = new Map<string, AdminUserRow["workspaces"]>();
  for (const m of (memberships ?? []) as unknown as Array<{
    user_id: string;
    role: string;
    workspace: { id: string; slug: string; name: string } | null;
  }>) {
    if (!m.workspace) continue;
    const list = byUser.get(m.user_id) ?? [];
    list.push({ ...m.workspace, role: personRole(m.role) });
    byUser.set(m.user_id, list);
  }
  for (const u of users) {
    u.workspaces = (byUser.get(u.id) ?? []).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const needle = params.q?.trim().toLowerCase();
  const matched = users.filter((u) => {
    if (needle && !(u.email ?? "").toLowerCase().includes(needle)) return false;
    if (params.workspace && !u.workspaces.some((w) => w.id === params.workspace)) {
      return false;
    }
    if (params.role && !u.workspaces.some((w) => w.role === params.role)) return false;
    if (params.state && userState(u) !== params.state) return false;
    return true;
  });
  matched.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return {
    items: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    offset,
    scanned: users.length,
    cap: AUTH_SCAN_CAP,
    capped: users.length >= AUTH_SCAN_CAP,
  };
}

/**
 * How far this person got. `invited` is somebody with a row and no password:
 * the invitation worked and they never arrived — the commonest way hand-made
 * onboarding fails quietly, and the reason the state exists at all.
 */
function userState(user: { confirmed: boolean; last_sign_in_at: string | null }): AdminUserState {
  if (!user.confirmed) return "invited";
  return user.last_sign_in_at ? "active" : "never-signed-in";
}

interface AuthUser {
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  confirmed: boolean;
}

/**
 * The auth server's view of a set of people. `listUsers` is paged, so this is
 * one walk of the list rather than a lookup per id, and it stops as soon as
 * everyone asked for has been found.
 */
async function usersForIds(userIds: string[]): Promise<Map<string, AuthUser>> {
  const wanted = new Set(userIds);
  const out = new Map<string, AuthUser>();
  if (wanted.size === 0) return out;
  const admin = getSupabaseAdmin();
  for (let page = 1; page <= 5; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const batch = data?.users ?? [];
    for (const u of batch) {
      if (!wanted.has(u.id)) continue;
      out.set(u.id, {
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
      });
    }
    if (batch.length < 200 || out.size === wanted.size) break;
  }
  return out;
}

/**
 * One person, everything the instance knows about them: the workspaces they
 * hold a membership in, the agents they connected, and their last write.
 * A fixed handful of queries, none of them per row.
 */
export async function getAdminUserDetail(id: string): Promise<AdminUserDetail> {
  const admin = getSupabaseAdmin();
  const person = (await usersForIds([id])).get(id);
  if (!person) throw new AdminWorkspaceError(404, "not_found");

  const [{ data: memberRows }, { data: agentRows }, lastActivityAt] = await Promise.all([
    admin
      .from("memberships")
      .select("role, workspace:workspaces!inner(id, slug, name)")
      .eq("user_id", id)
      .neq("role", "agent"),
    admin
      .from("agents")
      .select("id, name, provider, created_at, last_seen_at")
      .eq("owner_user_id", id),
    lastActivityByActor(id),
  ]);

  const workspaces: AdminUserWorkspace[] = ((memberRows ?? []) as unknown as Array<{
    role: string;
    workspace: { id: string; slug: string; name: string } | null;
  }>)
    .flatMap((m) => (m.workspace ? [{ ...m.workspace, role: personRole(m.role) }] : []))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    id,
    email: person.email,
    created_at: person.created_at,
    last_sign_in_at: person.last_sign_in_at,
    confirmed: person.confirmed,
    workspaces,
    agents: await agentsOwnedBy((agentRows ?? []) as OwnedAgentRow[]),
    last_activity_at: lastActivityAt,
  };
}

interface OwnedAgentRow {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/**
 * The agents this person connected. `last_used_at` is the newest of
 * `agents.last_seen_at` and the three token tables (`lastUsedByAgent`):
 * either alone reports a live agent as unused. Null is a real state, an
 * agent approved and never taken up.
 */
async function agentsOwnedBy(rows: OwnedAgentRow[]): Promise<AdminUserAgent[]> {
  if (rows.length === 0) return [];
  const agentIds = rows.map((a) => a.id);
  const [lastUsed, { data: access }] = await Promise.all([
    lastUsedByAgent(agentIds),
    getSupabaseAdmin()
      .from("agent_workspace_access")
      .select("agent_id")
      .in("agent_id", agentIds)
      .is("revoked_at", null),
  ]);
  const reach = new Map<string, number>();
  for (const row of (access ?? []) as Array<{ agent_id: string }>) {
    reach.set(row.agent_id, (reach.get(row.agent_id) ?? 0) + 1);
  }
  return rows
    .map((agent): AdminUserAgent => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      created_at: agent.created_at,
      last_used_at: newest(agent.last_seen_at, lastUsed.get(agent.id) ?? null),
      workspace_count: reach.get(agent.id) ?? 0,
    }))
    // Most recently active first; one that has never been used sorts last,
    // which is exactly the one an operator wants to notice.
    .sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));
}

/**
 * When this person last wrote anything, anywhere. Signing in is not being
 * around: only a write says the product is in use.
 */
async function lastActivityByActor(userId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("activity")
    .select("created_at")
    .eq("actor_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ created_at: string | null }>)[0]?.created_at ?? null;
}

/**
 * When each workspace was last written to. One seek per workspace on
 * `activity(workspace_id, created_at desc)`, which is the index that exists:
 * the newest row per workspace in a single statement is a lateral join
 * PostgREST cannot ask for.
 */
async function lastActivityByWorkspace(
  workspaceIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (workspaceIds.length === 0) return out;
  const admin = getSupabaseAdmin();
  await Promise.all(
    workspaceIds.map(async (id) => {
      const { data } = await admin
        .from("activity")
        .select("created_at")
        .eq("workspace_id", id)
        .order("created_at", { ascending: false })
        .limit(1);
      const at = ((data ?? []) as Array<{ created_at: string | null }>)[0]?.created_at;
      if (at) out.set(id, at);
    }),
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Health                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `activity` for the current month, in pages. Past this many writes a
 * workspace has outgrown row-level aggregation, and the health list is a
 * triage screen, not a ledger.
 */
const HEALTH_ACTIVITY_PAGE = 1000;
const HEALTH_ACTIVITY_MAX_PAGES = 20;

/**
 * How many workspaces the sweep will ever rank. The list's `total` counts
 * what it swept, so this is also the horizon of the count — past five hundred
 * the ranking is a query Postgres should be doing.
 */
const WORKSPACE_SWEEP_MAX = 500;

/**
 * Every workspace, ranked, for the Overview's alarm band. Deliberately NOT
 * paginated: this answers "is anything wrong anywhere", and a band that
 * counted the first fifty would go quiet exactly as the instance grew.
 */
export async function listAdminWorkspaceHealth(
  now: Date = new Date(),
): Promise<AdminWorkspaceHealthList> {
  const rows = await sweepWorkspaceHealth({ now });
  return {
    workspaces: rows.map(({ owner_emails: _owners, ...row }) => row),
  };
}

/** The health row plus every owner's address, which the list prints. */
interface HealthRow extends AdminWorkspaceHealth {
  owner_emails: string[];
}

interface SweepFilters {
  q?: string;
  now?: Date;
}

/**
 * One row per workspace, answering the four questions a hand-made onboarding
 * asks: has anyone accepted, has anyone signed in, has an agent connected,
 * and is the place still moving.
 *
 * `q` reaches the workspaces query (name, slug, or an owner's address — the
 * last resolved to workspace ids first, since addresses live in the auth
 * server). Everything else is read set-wide, one query each, and folded in
 * memory; the auth users list is walked once; and only the workspaces that
 * wrote nothing this month cost one more seek, for the date "quiet since"
 * needs. So the busy workspaces are the cheapest to report on.
 */
async function sweepWorkspaceHealth(filters: SweepFilters = {}): Promise<HealthRow[]> {
  const admin = getSupabaseAdmin();
  const now = filters.now ?? new Date();
  const period = currentPeriod(now);
  const previousPeriod = currentPeriod(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  );
  const since = periodStart(period);

  const term = searchTerm(filters.q);
  let wsQuery = admin
    .from("workspaces")
    .select("id, slug, name, created_at")
    .order("created_at", { ascending: false })
    .limit(WORKSPACE_SWEEP_MAX);
  if (term) {
    const byOwner = await workspaceIdsForOwnerEmail(term);
    const clauses = [`name.ilike.*${term}*`, `slug.ilike.*${term}*`];
    if (byOwner.length > 0) clauses.push(`id.in.(${byOwner.join(",")})`);
    wsQuery = wsQuery.or(clauses.join(","));
  }
  const { data: wsRows, error } = await wsQuery;
  if (error) throw new Error(`sweepWorkspaceHealth: ${error.message}`);

  const workspaces = (wsRows ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    created_at: string;
  }>;
  if (workspaces.length === 0) return [];
  // Only when a filter narrowed the set: unfiltered, the `in (…)` would name
  // every workspace there is, which is a longer URL and the same rows.
  const scope = term ? workspaces.map((w) => w.id) : null;
  const within = <T>(query: T): T =>
    scope ? (query as { in: (c: string, v: string[]) => T }).in("workspace_id", scope) : query;
  const wsIds = workspaces.map((w) => w.id);

  const [{ data: memberships }, { data: invites }] = await Promise.all([
    within(admin.from("memberships").select("workspace_id, user_id, role").neq("role", "agent")),
    within(
      admin
        .from("workspace_invites")
        .select("workspace_id, created_at")
        .is("accepted_at", null),
    ),
  ]);
  const memberRows = (memberships ?? []) as Array<{
    workspace_id: string;
    user_id: string;
    role: string;
  }>;

  const [people, agents, mcpCalls, mcpCallsBefore, activity, nodeCounts] = await Promise.all([
    usersForIds([...new Set(memberRows.map((m) => m.user_id))]),
    fetchAgentAccess(wsIds),
    fetchMcpCallsByWorkspace(wsIds, period),
    fetchMcpCallsByWorkspace(wsIds, previousPeriod),
    fetchMonthActivity(wsIds, since),
    countNodes(wsIds),
  ]);

  const byId = new Map<string, HealthRow>();
  for (const ws of workspaces) {
    byId.set(ws.id, {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      created_at: ws.created_at,
      owner_email: null,
      owner_emails: [],
      member_count: 0,
      node_count: nodeCounts.get(ws.id) ?? 0,
      oldest_pending_invite_at: null,
      pending_invite_count: 0,
      first_sign_in_at: null,
      last_sign_in_at: null,
      first_agent_connected_at: null,
      agent_count: 0,
      mcp_calls: mcpCalls.get(ws.id) ?? 0,
      mcp_calls_prev_month: mcpCallsBefore.get(ws.id) ?? 0,
      writes: 0,
      last_activity_at: null,
      // Overwritten once every counter has been folded in; a ladder read off
      // half-filled numbers would say "never signed in" about everybody.
      state: "never-accepted",
    });
  }

  for (const m of memberRows) {
    const row = byId.get(m.workspace_id);
    if (!row) continue;
    row.member_count += 1;
    const user = people.get(m.user_id);
    if (m.role === "owner" && user?.email) {
      row.owner_emails.push(user.email);
      row.owner_email ??= user.email;
    }
    // `auth.users` keeps only the LATEST sign-in, so "first" here is the
    // earliest sign-in known across the roster. The load-bearing half is the
    // null: members and no sign-in at all is an invitation that worked and a
    // product nobody opened.
    if (user?.last_sign_in_at) {
      row.first_sign_in_at = oldest(row.first_sign_in_at, user.last_sign_in_at);
      row.last_sign_in_at = newest(row.last_sign_in_at, user.last_sign_in_at);
    }
  }

  for (const invite of (invites ?? []) as Array<{ workspace_id: string; created_at: string }>) {
    const row = byId.get(invite.workspace_id);
    if (!row) continue;
    row.pending_invite_count += 1;
    row.oldest_pending_invite_at = oldest(row.oldest_pending_invite_at, invite.created_at);
  }

  const liveAgents = new Map<string, Set<string>>();
  for (const access of agents) {
    const row = byId.get(access.workspace_id);
    if (!row) continue;
    // Approval IS the connection. Revoked rows count here — the question is
    // whether the product was ever reached, and revoking does not unmake it.
    row.first_agent_connected_at = oldest(row.first_agent_connected_at, access.approved_at);
    if (access.revoked_at) continue;
    const seen = liveAgents.get(row.id) ?? new Set<string>();
    seen.add(access.agent_id);
    liveAgents.set(row.id, seen);
  }
  for (const [id, seen] of liveAgents) {
    const row = byId.get(id);
    if (row) row.agent_count = seen.size;
  }

  for (const a of activity) {
    if (!WRITE_VERBS.has(a.verb)) continue;
    const row = byId.get(a.workspace_id);
    if (!row) continue;
    row.writes += 1;
    row.last_activity_at = newest(row.last_activity_at, a.created_at);
  }

  // Only for the ones that wrote nothing this month: "quiet since March" is a
  // different answer from "never", and telling them apart is the point.
  const quiet = workspaces.filter((w) => byId.get(w.id)?.last_activity_at === null);
  const olderActivity = await lastActivityByWorkspace(quiet.map((w) => w.id));
  for (const [workspaceId, at] of olderActivity) {
    const row = byId.get(workspaceId);
    if (row) row.last_activity_at = newest(row.last_activity_at, at);
  }

  const rows = workspaces.map((w) => byId.get(w.id)!);
  for (const row of rows) row.state = adminWorkspaceState(row);
  return rows;
}

/**
 * The workspaces whose owners' addresses match the search box. Addresses
 * live in the auth server, which nothing joins to, so an email search becomes
 * part of the query by resolving it to ids first.
 */
async function workspaceIdsForOwnerEmail(term: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  const needle = term.toLowerCase();
  const userIds: string[] = [];
  for (let page = 1; page * AUTH_PAGE <= AUTH_SCAN_CAP; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE });
    const batch = data?.users ?? [];
    for (const u of batch) {
      if ((u.email ?? "").toLowerCase().includes(needle)) userIds.push(u.id);
    }
    if (batch.length < AUTH_PAGE) break;
  }
  if (userIds.length === 0) return [];
  const { data } = await admin
    .from("memberships")
    .select("workspace_id")
    .eq("role", "owner")
    .in("user_id", userIds);
  return [
    ...new Set(((data ?? []) as Array<{ workspace_id: string }>).map((m) => m.workspace_id)),
  ];
}

interface AgentAccessRow {
  agent_id: string;
  workspace_id: string;
  approved_at: string;
  revoked_at: string | null;
}

async function fetchAgentAccess(workspaceIds: string[]): Promise<AgentAccessRow[]> {
  if (workspaceIds.length === 0) return [];
  const { data } = await getSupabaseAdmin()
    .from("agent_workspace_access")
    .select("agent_id, workspace_id, approved_at, revoked_at")
    .in("workspace_id", workspaceIds);
  return (data ?? []) as AgentAccessRow[];
}

/** Reads this month, per workspace, from `mcp_usage_counters`. */
async function fetchMcpCallsByWorkspace(
  workspaceIds: string[],
  period: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data, error } = await getSupabaseAdmin()
    .from("mcp_usage_counters")
    .select("workspace_id, calls")
    .in("workspace_id", workspaceIds)
    .eq("period", period);
  if (error) return out;
  for (const row of (data ?? []) as Array<{ workspace_id: string; calls: number | null }>) {
    out.set(row.workspace_id, (out.get(row.workspace_id) ?? 0) + (row.calls ?? 0));
  }
  return out;
}

interface HealthActivityRow {
  workspace_id: string;
  verb: string;
  created_at: string;
}

async function fetchMonthActivity(
  workspaceIds: string[],
  since: string,
): Promise<HealthActivityRow[]> {
  if (workspaceIds.length === 0) return [];
  const admin = getSupabaseAdmin();
  const rows: HealthActivityRow[] = [];
  for (let page = 0; page < HEALTH_ACTIVITY_MAX_PAGES; page++) {
    const from = page * HEALTH_ACTIVITY_PAGE;
    const { data, error } = await admin
      .from("activity")
      .select("workspace_id, verb, created_at")
      .in("workspace_id", workspaceIds)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + HEALTH_ACTIVITY_PAGE - 1);
    if (error) break; // Partial counts beat a broken screen; nothing here is billed.
    const batch = (data ?? []) as HealthActivityRow[];
    rows.push(...batch);
    if (batch.length < HEALTH_ACTIVITY_PAGE) break;
  }
  return rows;
}

function oldest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

async function inviteRow(id: string): Promise<InviteRow> {
  const { data } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .eq("id", id)
    .single();
  return data as InviteRow;
}

/**
 * Create a workspace and the invitation that hands it to its first owner.
 *
 * The workspace is born empty on purpose: the owner's membership is written
 * when they accept, by the same path every other member goes through, so
 * there is never a membership pointing at an account that does not exist
 * yet. The admin is recorded as the inviter.
 */
export async function createAdminWorkspace(input: {
  name: string;
  slug?: string;
  ownerEmail: string;
  role: InviteRole;
  adminUserId: string;
}): Promise<{ workspace: AdminWorkspaceBase; invite: AdminInvite }> {
  const email = input.ownerEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AdminWorkspaceError(400, "invalid_email", "Enter a valid owner email.");
  }
  let ws;
  try {
    ws = await insertWorkspace({ name: input.name, slug: input.slug });
  } catch (err) {
    if (err instanceof WorkspaceCreateError && err.status !== 403 && err.status !== 404) {
      throw new AdminWorkspaceError(err.status, err.code, err.message);
    }
    throw err;
  }

  const created = await createWorkspaceInvite({
    workspaceId: ws.id,
    email,
    role: input.role,
    invitedBy: input.adminUserId,
  });

  log.info("admin.workspace.created", {
    workspace_id: ws.id,
    slug: ws.slug,
    email_domain: email.split("@")[1] ?? null,
    role: input.role,
  });

  const invite = toAdminInvite(await inviteRow(created.id));
  return {
    workspace: {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      created_at: ws.created_at,
      member_count: 0,
      pending_invite_count: 1,
      owner_emails: [],
      pending_invites: [invite],
    },
    invite,
  };
}

/** Rename a workspace. The slug is an address and never moves. */
export async function updateAdminWorkspace(
  id: string,
  patch: { name?: string },
  adminUserId: string,
): Promise<AdminWorkspaceDetailWithSpend> {
  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (!current) throw new AdminWorkspaceError(404, "not_found");

  if (patch.name === undefined) {
    throw new AdminWorkspaceError(400, "empty_patch", "Nothing to change.");
  }
  const name = patch.name.trim();
  if (!name) throw new AdminWorkspaceError(400, "invalid_name", "The workspace needs a name.");

  const { error } = await admin.from("workspaces").update({ name }).eq("id", id);
  if (error) throw new Error(`updateAdminWorkspace: ${error.message}`);
  log.info("admin.workspace.renamed", {
    workspace_id: id,
    admin_user_id: adminUserId,
    from: current.name as string,
    to: name,
  });

  return getAdminWorkspaceDetail(id);
}

/** A further invitation into an existing workspace. Link only. */
export async function createAdminInvite(input: {
  workspaceId: string;
  email: string;
  role: InviteRole;
  adminUserId: string;
}): Promise<AdminInvite> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AdminWorkspaceError(400, "invalid_email", "Enter a valid email.");
  }
  const { data: ws } = await getSupabaseAdmin()
    .from("workspaces")
    .select("id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (!ws) throw new AdminWorkspaceError(404, "not_found");

  const created = await createWorkspaceInvite({
    workspaceId: input.workspaceId,
    email,
    role: input.role,
    invitedBy: input.adminUserId,
  });
  return toAdminInvite(await inviteRow(created.id));
}

export async function revokeAdminInvite(workspaceId: string, inviteId: string): Promise<void> {
  await revokeWorkspaceInvite(workspaceId, inviteId);
}

/**
 * The one irreversible act, done only when the admin asks for it by name.
 * The outcome is written back on the row (`deliverInvite`), so a failed send
 * is visible in the panel rather than assumed.
 */
export async function sendAdminInviteEmail(inviteId: string): Promise<AdminInvite> {
  try {
    return toAdminInvite(await deliverInvite(inviteId));
  } catch (err) {
    if (err instanceof InviteDeliveryError) {
      throw new AdminWorkspaceError(err.status, err.code, err.message);
    }
    throw err;
  }
}
