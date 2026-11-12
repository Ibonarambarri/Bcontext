/**
 * The people of a workspace: roster, roles, role-keyed invitations and their
 * acceptance.
 *
 * Called by the members routes (`/api/workspaces/:ws/members/**`,
 * `/api/workspaces/:ws/invites/**`), the invite token routes
 * (`/api/invites/:token/**`), `@/lib/auth/invitations` for role-only
 * invitations, and the instance admin (`@/lib/admin/workspaces`), which
 * creates invitations into a workspace it is not a member of.
 *
 * A person's place in a workspace is two rows that must never drift apart:
 * the `memberships` row (role; what node RLS and this roster read) and the
 * `workspace_grants` row, which is authoritative for access. Every write here
 * keeps them in step through `syncGrantFromMembership`.
 *
 * Must not break: everything runs on the service-role client, so callers
 * authorise first (`openWorkspace(…, "admin")` or the instance-admin gate).
 * A workspace always keeps at least one owner — no route can put one back
 * once the last is gone.
 */
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { namesFromUser } from "@/lib/auth/profile";
import { lastUsedByAgent } from "@/lib/agents/last-used";
import { inviteUrl } from "@/lib/app-url";
import { supabaseConfigured } from "@/lib/env";
import { log } from "@bcontext-dev/contract/log";
import { joinName } from "@bcontext-dev/contract/me";
import {
  deliverInvite,
  INVITE_COLUMNS,
  InviteDeliveryError,
  type InviteRow,
} from "@/lib/workspaces/invite-email";
import type {
  InviteEmailStatus,
  InviteRole,
  SendWorkspaceInviteEmailResult,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceMemberAgent,
  WorkspaceMemberDetail,
} from "@bcontext-dev/contract/workspaces";

export class MembersError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MembersError";
  }
}

const INVITE_TTL_MS = 14 * 86_400_000;

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/** The caller's role in the workspace, or null when they hold none. */
export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<InviteRole | null> {
  if (!supabaseConfigured()) return null;
  const { data } = await getSupabaseAdmin()
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  const role = data?.role as string | undefined;
  return role && role !== "agent" ? (role as InviteRole) : null;
}

interface MembershipRow {
  user_id: string;
  role: InviteRole;
  created_at: string | null;
}

/**
 * The people in a workspace, as the request path sees them.
 *
 * A person whose grant was revoked or expired is left out even though their
 * membership row survives, because the grant is authoritative and denies
 * before anything else is asked. The screen shows the access somebody
 * actually has, not the access their rows suggest. `agent` rows (a legacy
 * role on `memberships`) are not people and are never listed.
 */
async function activeMemberships(workspaceId: string): Promise<MembershipRow[]> {
  const admin = getSupabaseAdmin();
  const [{ data: rows }, { data: grants }] = await Promise.all([
    admin
      .from("memberships")
      .select("user_id, role, created_at")
      .eq("workspace_id", workspaceId)
      .neq("role", "agent")
      .order("created_at", { ascending: true }),
    admin
      .from("workspace_grants")
      .select("principal_id, revoked_at, expires_at")
      .eq("workspace_id", workspaceId)
      .eq("principal_kind", "user"),
  ]);
  const denied = new Set<string>();
  for (const g of (grants ?? []) as Array<{
    principal_id: string;
    revoked_at: string | null;
    expires_at: string | null;
  }>) {
    const expired = g.expires_at !== null && new Date(g.expires_at) <= new Date();
    if (g.revoked_at !== null || expired) denied.add(g.principal_id);
  }
  return ((rows ?? []) as MembershipRow[]).filter((m) => !denied.has(m.user_id));
}

interface AuthUser {
  email: string | null;
  name: string | null;
  last_sign_in_at: string | null;
  confirmed: boolean;
}

/**
 * Emails and sign-in state for a set of user ids. The auth server pages its
 * user list and has no "give me these ids" call, so this walks it and stops
 * as soon as everyone asked for has been found — or at 1 000 people, far past
 * the size where one workspace's roster fits on a screen.
 */
export async function usersById(userIds: string[]): Promise<Map<string, AuthUser>> {
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
        name: joinName(namesFromUser(u)),
        last_sign_in_at: u.last_sign_in_at ?? null,
        // Somebody who was invited and never set a password has no
        // confirmation, which is what tells "waiting" apart from "using it".
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
      });
    }
    if (batch.length < 200 || out.size === wanted.size) break;
  }
  return out;
}

function toMember(m: MembershipRow, user: AuthUser | undefined, callerId: string): WorkspaceMember {
  return {
    user_id: m.user_id,
    email: user?.email ?? null,
    name: user?.name ?? null,
    role: m.role,
    joined_at: m.created_at,
    last_sign_in_at: user?.last_sign_in_at ?? null,
    confirmed: user?.confirmed ?? false,
    is_you: m.user_id === callerId,
  };
}

export function toWorkspaceInvite(row: InviteRow): WorkspaceInvite {
  const state = row.delivery_state;
  const emailStatus: InviteEmailStatus | null =
    state === "sent" ? "sent" : state === "failed" ? "error" : null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    url: inviteUrl(row.token),
    expires_at: row.expires_at,
    created_at: row.created_at,
    email_status: emailStatus,
    email_sent_at: row.delivery_at,
    email_error: row.delivery_error,
  };
}

/** The roster, and — for someone who administers it — the open invitations. */
export async function listWorkspaceRoster(
  workspaceId: string,
  callerId: string,
  options: { withInvites: boolean },
): Promise<{ members: WorkspaceMember[]; invites: WorkspaceInvite[] }> {
  const admin = getSupabaseAdmin();
  const [memberships, invites] = await Promise.all([
    activeMemberships(workspaceId),
    options.withInvites
      ? admin
          .from("workspace_invites")
          .select(INVITE_COLUMNS)
          .eq("workspace_id", workspaceId)
          .is("accepted_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as InviteRow[] }),
  ]);
  const users = await usersById(memberships.map((m) => m.user_id));
  return {
    members: memberships.map((m) => toMember(m, users.get(m.user_id), callerId)),
    invites: ((invites.data ?? []) as InviteRow[]).map(toWorkspaceInvite),
  };
}

/** One person in full: their membership and the agents they connected here. */
export async function getWorkspaceMemberDetail(
  workspaceId: string,
  userId: string,
  callerId: string,
): Promise<WorkspaceMemberDetail> {
  const memberships = await activeMemberships(workspaceId);
  const target = memberships.find((m) => m.user_id === userId);
  if (!target) throw new MembersError(404, "not_found");

  const admin = getSupabaseAdmin();
  const [users, { data: access }] = await Promise.all([
    usersById([userId]),
    admin
      .from("agent_workspace_access")
      .select("scopes, agent:agents!inner(id, name, provider, created_at, owner_user_id, status)")
      .eq("workspace_id", workspaceId)
      .eq("agent.owner_user_id", userId)
      .is("revoked_at", null),
  ]);

  const rows = ((access ?? []) as unknown as Array<{
    scopes: string[] | null;
    agent: { id: string; name: string; provider: string | null; created_at: string; status: string } | null;
  }>).filter((r) => r.agent && r.agent.status !== "revoked");
  const lastUsed = await lastUsedByAgent(rows.map((r) => r.agent!.id));
  const agents: WorkspaceMemberAgent[] = rows
    .map((r) => ({
      id: r.agent!.id,
      name: r.agent!.name,
      provider: r.agent!.provider ?? null,
      created_at: r.agent!.created_at,
      last_used_at: lastUsed.get(r.agent!.id) ?? null,
      scopes: r.scopes ?? [],
    }))
    // Most recently active first; one never used sorts last, which is exactly
    // the one an administrator wants to notice and revoke.
    .sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));

  const owners = memberships.filter((m) => m.role === "owner").length;
  return {
    ...toMember(target, users.get(userId), callerId),
    is_last_owner: target.role === "owner" && owners <= 1,
    agents,
  };
}

/* -------------------------------------------------------------------------- */
/*  Members                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A workspace with no owner is one nobody can administer, and no route here
 * can put an owner back — the invitation that would is issued by an
 * administrator who no longer exists.
 */
function assertNotLastOwner(
  members: MembershipRow[],
  target: MembershipRow,
  action: "demote" | "remove",
): void {
  if (target.role !== "owner") return;
  if (members.filter((m) => m.role === "owner").length > 1) return;
  throw new MembersError(
    409,
    "last_owner",
    action === "demote"
      ? "This is the workspace's only owner — make somebody else an owner first."
      : "This is the workspace's only owner — hand the workspace over first.",
  );
}

/** Change somebody's role. The grant follows in the same breath. */
export async function updateWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: InviteRole,
  callerId: string,
): Promise<void> {
  const members = await activeMemberships(workspaceId);
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw new MembersError(404, "not_found");
  if (target.role === role) return;

  assertNotLastOwner(members, target, "demote");
  if (userId === callerId && target.role === "owner") {
    // An owner who demotes themselves loses the ability to undo it in the
    // same click. If that is genuinely what they want, another owner does it.
    throw new MembersError(
      409,
      "self_demotion",
      "You cannot change your own owner role — ask another owner to do it.",
    );
  }

  await getSupabaseAdmin()
    .from("memberships")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  // Without `reinstate`, deliberately: re-picking a role for somebody whose
  // grant was revoked must not quietly restore access an admin took away.
  await syncGrantFromMembership(workspaceId, userId, role);
  log.info("workspace.member.role_changed", { workspace_id: workspaceId, user_id: userId, role });
}

/** Take somebody out: the membership and the grant, together. */
export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string,
  callerId: string,
): Promise<void> {
  const members = await activeMemberships(workspaceId);
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw new MembersError(404, "not_found");

  assertNotLastOwner(members, target, "remove");
  if (userId === callerId) {
    throw new MembersError(
      409,
      "self_removal",
      "You can't remove yourself — ask another owner or admin to do it.",
    );
  }

  await getSupabaseAdmin()
    .from("memberships")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  // Grants are authoritative: deleting the membership alone would leave the
  // access alive. Revocation happens at write time, not on every read.
  await syncGrantFromMembership(workspaceId, userId, null);
  log.info("workspace.member.removed", { workspace_id: workspaceId, user_id: userId });
}

/* -------------------------------------------------------------------------- */
/*  Invitations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Invite an address into the workspace with a role, and answer with the
 * link. Nothing is emailed: sending is the one irreversible act and has its
 * own call (`sendWorkspaceInvite`). A pending invitation for the same
 * address is refreshed rather than stacked.
 */
export async function createWorkspaceInvite(input: {
  workspaceId: string;
  email: string;
  role: InviteRole;
  invitedBy: string;
}): Promise<WorkspaceInvite & { token: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new MembersError(400, "invalid_email", "Enter a valid email address.");
  }
  const admin = getSupabaseAdmin();
  const token = newToken();

  const { data: existing } = await admin
    .from("workspace_invites")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("email", email)
    .is("accepted_at", null)
    .maybeSingle();

  const fields = {
    role: input.role,
    token,
    invited_by: input.invitedBy,
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    // A refreshed invitation is a new one: whatever happened to the old
    // email no longer describes this link.
    delivery_state: "pending",
    delivery_at: null,
    delivery_error: null,
  };
  const { data, error } = existing?.id
    ? await admin
        .from("workspace_invites")
        .update(fields)
        .eq("id", existing.id)
        .select(INVITE_COLUMNS)
        .single()
    : await admin
        .from("workspace_invites")
        .insert({ ...fields, workspace_id: input.workspaceId, email })
        .select(INVITE_COLUMNS)
        .single();
  if (error || !data) {
    throw new Error(`createWorkspaceInvite: ${error?.message ?? "no row"}`);
  }

  log.info("workspace.invite.created", {
    workspace_id: input.workspaceId,
    role: input.role,
    email_domain: email.split("@")[1] ?? null,
  });
  return { ...toWorkspaceInvite(data as InviteRow), token };
}

/** A pending invitation, withdrawn. The link dies with the row. */
export async function revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<void> {
  await getSupabaseAdmin()
    .from("workspace_invites")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", inviteId);
}

/**
 * Send the email for an invitation this workspace issued. Scoped first: an
 * id from another workspace must not become an email sent in its name.
 */
export async function sendWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<SendWorkspaceInviteEmailResult> {
  const { data } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select("id")
    .eq("id", inviteId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) throw new MembersError(404, "not_found");
  try {
    const row = await deliverInvite(inviteId);
    const invite = toWorkspaceInvite(row);
    return {
      status: invite.email_status ?? "skipped",
      error: row.delivery_error,
      invite,
    };
  } catch (err) {
    if (err instanceof InviteDeliveryError) {
      throw new MembersError(err.status, err.code, err.message);
    }
    throw err;
  }
}

/** An open invitation, as the token routes need it. */
export interface OpenInvite {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  expires_at: string;
  created_at: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
}

/**
 * Look up an invite by its public token. Null for missing, expired or
 * already-accepted invites, so callers do not branch on each case.
 */
export async function findInviteByToken(token: string): Promise<OpenInvite | null> {
  if (!supabaseConfigured()) return null;
  const { data } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select(
      "id, email, role, token, expires_at, accepted_at, created_at, workspace_id, workspace:workspaces(slug, name)",
    )
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (data.accepted_at) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  const ws = (data as { workspace?: { slug: string; name: string } | null }).workspace;
  return {
    id: data.id as string,
    email: data.email as string,
    role: data.role as InviteRole,
    token: data.token as string,
    expires_at: data.expires_at as string,
    created_at: data.created_at as string,
    workspace_id: data.workspace_id as string,
    workspace_slug: ws?.slug ?? "",
    workspace_name: ws?.name ?? "",
  };
}

/**
 * Accept a role invitation for the signed-in user: the membership with the
 * invited role, and the grant beside it.
 */
export async function acceptRoleInvite(
  token: string,
  user: { id: string; email: string | null },
): Promise<{ workspaceSlug: string } | { error: string }> {
  const invite = await findInviteByToken(token);
  if (!invite) return { error: "Invitation is invalid or expired." };

  if (user.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return {
      error: `This invitation was sent to ${invite.email}. Sign in with that email to accept.`,
    };
  }

  const admin = getSupabaseAdmin();
  await admin
    .from("memberships")
    .upsert(
      { user_id: user.id, workspace_id: invite.workspace_id, role: invite.role },
      { onConflict: "user_id,workspace_id" },
    );
  // `reinstate` because this is a readmission: someone removed before —
  // leaving a revoked grant behind — has just been invited back, and a
  // tombstone outliving that invitation would lock them out of a workspace
  // they appear on the members list of, with no error to explain it.
  await syncGrantFromMembership(invite.workspace_id, user.id, invite.role, { reinstate: true });

  await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invite.id);

  return { workspaceSlug: invite.workspace_slug };
}
