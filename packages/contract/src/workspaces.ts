/**
 * Workspaces, membership and invitations, as the API returns them and the
 * hub / workspace panel / invite / consent pages render them.
 *
 * A workspace is the single top-level entity: it has the people (members
 * with a role), the agents, the invitations and the usage. There is no layer
 * above it. Its slug is unique across the instance and is its address.
 *
 * Part of the contract between bcontext-api and bcontext-web. The reads and
 * writes behind these live in `@/lib/workspaces/*` and `@/lib/auth/invitations`
 * on the API side; the web side only ever sees these shapes, over HTTP.
 */
import type { Workspace } from "./types.js";
import type { BusinessModel } from "./business/record-types.js";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer" | "agent";

/** A role an invitation can carry. `agent` is a token's role, never a person's. */
export type InviteRole = Exclude<WorkspaceRole, "agent">;

/** Where an invitation email got to, when somebody asked for one. */
export type InviteEmailStatus = "sent" | "skipped" | "error";

/* -------------------------------------------------------------------------- */
/*  Creation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Who may create a workspace on this instance, from `WORKSPACE_CREATION`:
 * `open` lets any signed-in person create one (and sign up), `admin` keeps
 * it to the instance admins (`ADMIN_EMAILS`), who then invite the owners.
 */
export type WorkspaceCreationPolicy = "open" | "admin";

export const WORKSPACE_CREATION_POLICIES: readonly WorkspaceCreationPolicy[] = ["open", "admin"];

/** How long a workspace's name may be; the slug follows the same cap. */
export const WORKSPACE_NAME_MAX = 80;

/**
 * `POST /api/workspaces` body. The creator becomes its owner. The slug is
 * derived from the name and disambiguated across the instance (`docs`,
 * `docs-2`) — never supplied, because it is an address, not a label.
 */
export interface CreateWorkspaceBody {
  name: string;
  description?: string;
  /**
   * What kind of business it is. Anything but `product` (the default) also
   * applies that model's template: its record types and views
   * (`business/templates.ts`), as defaults the team edits afterwards.
   */
  business_model?: BusinessModel;
}

/** `201` from `POST /api/workspaces`. */
export interface CreateWorkspaceResult {
  workspace: Workspace;
  /** When a business model was chosen: what its template created and skipped. */
  business_template?: {
    model: BusinessModel;
    created: { record_types: string[]; views: Array<{ key: string; id: string; name: string }> };
    skipped: Array<{ what: "record_type" | "view"; key: string; reason: string }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  The hub                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A workspace as the hub shows it: the row plus what the caller holds in it
 * and the numbers on the card. `GET /api/workspaces?stats=1`.
 */
export interface WorkspaceCard extends Workspace {
  role: WorkspaceRole;
  member_count: number;
  open_task_count: number;
  node_count: number;
  last_activity_at: string;
}

/** `GET /api/workspaces` — the hub's single read. */
export interface WorkspacesResponse {
  workspaces: WorkspaceCard[];
  /** Whether "New workspace" is offered: see `WorkspaceCreationPolicy`. */
  can_create_workspace: boolean;
}

/**
 * `GET /api/workspaces/:ws` — one workspace the caller can read. `:ws` may
 * also be a legacy `<org>~<workspace>` pair; the answer always carries the
 * current slug, which is how the web turns an old `/w/<org>/<ws>` URL into
 * its permanent redirect.
 */
export interface WorkspaceResponse {
  workspace: Workspace;
}

/**
 * `PATCH /api/workspaces/:ws` body. Every field optional; nothing given is a
 * no-op. The slug is not here on purpose: it is generated from the name when
 * the workspace is created and then frozen, because it is the address people
 * and agents have written down.
 */
export interface WorkspacePatch {
  name?: string;
  /** 0–360, or null to leave the deterministic accent in place. */
  accent_hue?: number | null;
  /** A `GRADIENTS` id from `@/lib/workspace-gradients`. */
  accent_gradient?: string;
}

/* -------------------------------------------------------------------------- */
/*  People                                                                    */
/* -------------------------------------------------------------------------- */

/** One person in a workspace, as its members screen lists them. */
export interface WorkspaceMember {
  user_id: string;
  email: string | null;
  /** Their profile name, joined; null while they have not given one. */
  name: string | null;
  role: InviteRole;
  joined_at: string | null;
  last_sign_in_at: string | null;
  /** False while the person was created or invited and never signed in. */
  confirmed: boolean;
  /** True for the caller's own row, so the UI can refuse to lock them out. */
  is_you: boolean;
}

/** An open invitation to the workspace. */
export interface WorkspaceInvite {
  id: string;
  email: string;
  role: InviteRole;
  /** Absolute /invite/<token> URL — what the panel copies and shares. */
  url: string;
  expires_at: string;
  created_at: string;
  email_status: InviteEmailStatus | null;
  email_sent_at: string | null;
  email_error: string | null;
}

/**
 * `GET /api/workspaces/:ws/members` — the members screen: roster, open
 * invitations (only for someone who administers the workspace) and the
 * caller's own role.
 */
export interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  role: WorkspaceRole | null;
  can_manage: boolean;
  /** Set when the workspace lives in demo storage: no roster exists. */
  demo?: boolean;
}

/**
 * `POST /api/workspaces/:ws/invites` — how a person is added, and the only
 * way. Creating one sends nothing; the reply carries the link, and emailing
 * it is a second, explicit call (`POST …/invites/:id/email`).
 */
export interface CreateWorkspaceInviteBody {
  email: string;
  role?: InviteRole;
}

/** `201` from `POST /api/workspaces/:ws/invites`. */
export interface CreateWorkspaceInviteResult {
  invite: WorkspaceInvite;
}

/** `POST /api/workspaces/:ws/invites/:id/email`. */
export interface SendWorkspaceInviteEmailResult {
  status: InviteEmailStatus;
  error: string | null;
  invite: WorkspaceInvite;
}

/** `PATCH /api/workspaces/:ws/members/:userId`. */
export interface WorkspaceMemberPatch {
  role: InviteRole;
}

/** An agent a member connected to this workspace. */
export interface WorkspaceMemberAgent {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_used_at: string | null;
  scopes: string[];
}

/**
 * `GET /api/workspaces/:ws/members/:userId` — one person in full: their
 * membership and the agents they connected here, which act in their name.
 */
export interface WorkspaceMemberDetail extends WorkspaceMember {
  /** True while this is the last owner: the UI must not offer to demote them. */
  is_last_owner: boolean;
  agents: WorkspaceMemberAgent[];
}

/* -------------------------------------------------------------------------- */
/*  Usage                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * MCP tool calls: the only measure of how much a workspace's context is
 * READ. `activity` records writes only. Split by tool because they are not
 * the same thing: `ping` is noise, `nodes(op=search)` is a retrieval.
 */
export interface McpToolUsage {
  tool: string;
  calls: number;
}

export interface McpUsage {
  total: number;
  /** Busiest tool first. */
  by_tool: McpToolUsage[];
}

/**
 * `GET /api/workspaces/:ws/usage` — what the workspace is consuming this
 * month. Measured, never priced: every field is something the database
 * counts, for an administrator to read. There are no ceilings.
 */
export interface WorkspaceUsage {
  /** `YYYY-MM` — the month the counters cover. */
  period: string;
  nodes_total: number;
  nodes_created: number;
  nodes_edited: number;
  /**
   * Writes split by who made them. They do not add up to the total on
   * purpose: a migration or a backfill writes as `system`, and crediting
   * that to either side would claim work nobody did.
   */
  writes_by_people: number;
  writes_by_agents: number;
  ai_queries: number;
  meeting_minutes: number;
  member_count: number;
  agent_count: number;
  mcp_calls: McpUsage;
}

/* -------------------------------------------------------------------------- */
/*  Invitations, from the invitee's side                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the invite page shows before the person signs in. The token is what
 * they used to ask, so it is not echoed back.
 */
export interface InvitePreview {
  email: string;
  role: InviteRole;
  workspace_name: string;
  workspace_slug: string;
  expires_at: string;
}

/** `POST /api/invites/:token/accept` — where to land the person. */
export interface InviteAccepted {
  workspaceSlug: string;
}

/**
 * The registered OAuth client, reduced to what the consent screen shows and
 * checks. The secret hash and the registrant never leave the API.
 */
export interface OAuthClientPublic {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  scope: string;
  client_uri: string | null;
  logo_uri: string | null;
}
