/**
 * Workspace-invite email delivery via Resend.
 *
 * Nothing here fires on its own. An invitation is created as a link, and a
 * person decides whether it travels by email at all — see `deliverInvite`,
 * called by the members screen and by the instance admin panel. The recipient lands on `/invite/<token>`, where the
 * page accepts the invitation once they're signed in (or offers an inline
 * signup if they don't have an account yet).
 *
 * Two voices, one template: `owner` is an instance admin handing a team the
 * workspace they created for it ("it's ready, start using it"), `member` is
 * someone already inside adding a colleague. The product is named by
 * `INSTANCE_NAME` (`@/lib/emails/sender`). The shell — the brand's paper palette, the one
 * highlighted word in a serif italic — is shared with every other letter the
 * product sends (`@/lib/emails/paper`); only the words are here.
 *
 * Required env (without either of the first two the mail is skipped):
 *   RESEND_API_KEY       — Resend project API key
 *   EMAIL_FROM           — RFC-5322 from address (see `@/lib/emails/sender`)
 *   APP_URL              — base URL used to build the invite link (see `@/lib/app-url`)
 */
import { Resend } from "resend";
import { log } from "@bcontext-dev/contract/log";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { appBaseUrl } from "@/lib/app-url";
import { emailFrom, instanceName } from "@/lib/emails/sender";
import {
  escapeHtml,
  renderPaperHtml,
  renderPaperText,
  type PaperEmail,
} from "@/lib/emails/paper";

export type InviteEmailVariant = "owner" | "member";

export interface InviteEmailInput {
  email: string;
  inviteToken: string;
  workspaceName: string;
  role: "owner" | "admin" | "editor" | "viewer";
  invitedByEmail?: string | null;
  /** `owner` is the hand-made onboarding mail; defaults to `member`. */
  variant?: InviteEmailVariant;
}

export type InviteEmailStatus = "sent" | "skipped" | "error";

export interface InviteEmailResult {
  status: InviteEmailStatus;
  error: string | null;
  messageId: string | null;
}

/**
 * What the mail says, per variant. The accent word is the only italic —
 * same move as the product's headlines, and it survives a serif fallback
 * because Georgia is everywhere.
 */
function copyFor(input: {
  variant: InviteEmailVariant;
  workspaceName: string;
  role: string;
  inviteUrl: string;
  invitedByEmail?: string | null;
}): PaperEmail {
  const ws = escapeHtml(input.workspaceName);
  const role = escapeHtml(input.role);
  const product = instanceName();
  const productHtml = escapeHtml(product);
  const footnotes = [
    "The link expires in 14 days. If it has, ask for a fresh one.",
    "Not expecting this? You can safely ignore the message — no account will be created.",
  ];

  if (input.variant === "owner") {
    return {
      kicker: `${product.toLowerCase()} · your workspace`,
      headlineLead: `${input.workspaceName} is`,
      headlineAccent: "ready.",
      paragraphs: [
        `<strong>${ws}</strong> has been set up for you on ${productHtml}. Open it below to finish setting it up — you'll create your account on the way in, and you land as its owner.`,
        "From there you can add your team, connect Claude Code or any MCP client, and start writing the context your agents will read.",
      ],
      cta: { label: "Start using your workspace →", url: input.inviteUrl },
      footnotes,
      subject: `${input.workspaceName} is ready on ${product}`,
    };
  }

  const inviterLine = input.invitedByEmail
    ? [`${escapeHtml(input.invitedByEmail)} added you to the team.`]
    : [];

  return {
    kicker: `${product.toLowerCase()} · workspace invitation`,
    headlineLead: "You've been invited to",
    headlineAccent: `${input.workspaceName}.`,
    paragraphs: [
      ...inviterLine,
      `You'll join the <strong>${ws}</strong> workspace on ${productHtml} as a <strong>${role}</strong>. Accept the invitation below — it takes a few seconds.`,
      `If you don't have a ${productHtml} account yet, you'll be able to create one from the same page using this email address.`,
    ],
    cta: { label: "Accept invitation →", url: input.inviteUrl },
    footnotes,
    subject: `You've been invited to ${input.workspaceName} on ${product}`,
  };
}

export async function sendWorkspaceInviteEmail(
  input: InviteEmailInput,
): Promise<InviteEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("workspace_invite.email.skipped", {
      reason: "missing RESEND_API_KEY",
      workspace_name: input.workspaceName,
    });
    return { status: "skipped", error: "RESEND_API_KEY not set", messageId: null };
  }
  const from = emailFrom();
  if (!from) {
    log.warn("workspace_invite.email.skipped", {
      reason: "missing EMAIL_FROM",
      workspace_name: input.workspaceName,
    });
    return { status: "skipped", error: "EMAIL_FROM not set", messageId: null };
  }

  const inviteUrl = `${appBaseUrl()}/invite/${input.inviteToken}`;
  const copy = copyFor({
    variant: input.variant ?? "member",
    workspaceName: input.workspaceName,
    role: input.role,
    inviteUrl,
    invitedByEmail: input.invitedByEmail ?? null,
  });

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: [input.email],
      subject: copy.subject,
      html: renderPaperHtml(copy),
      text: renderPaperText(copy),
      tags: [
        { name: "type", value: input.variant === "owner" ? "workspace_ready" : "workspace_invite" },
      ],
    });

    if (result.error) {
      log.error("workspace_invite.email.failed", {
        workspace_name: input.workspaceName,
        error: result.error.message ?? "resend error",
      });
      return {
        status: "error",
        error: result.error.message ?? "resend error",
        messageId: null,
      };
    }

    log.info("workspace_invite.email.sent", {
      workspace_name: input.workspaceName,
      message_id: result.data?.id ?? null,
    });
    return { status: "sent", error: null, messageId: result.data?.id ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    log.error("workspace_invite.email.failed", {
      workspace_name: input.workspaceName,
      error: msg,
    });
    return { status: "error", error: msg, messageId: null };
  }
}

/** The row columns every invitation reader needs, the delivery state included. */
export const INVITE_COLUMNS =
  "id, workspace_id, email, role, token, expires_at, accepted_at, created_at, delivery_state, delivery_at, delivery_error";

export interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer";
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  delivery_state: string | null;
  delivery_at: string | null;
  delivery_error: string | null;
}

/** Why `deliverInvite` refused: the row is missing, used or expired. */
export class InviteDeliveryError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: "not_found" | "already_accepted" | "expired",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "InviteDeliveryError";
  }
}

/**
 * The one irreversible act, done only when somebody asks for it by name.
 * The outcome is written back on the row so a failed send is visible on the
 * screen rather than assumed — and the link is still there to fall back on.
 *
 * Callers scope `inviteId` first (the members screen to its own workspace,
 * the instance admin to any): this function asks no questions about who may
 * send it.
 */
export async function deliverInvite(inviteId: string): Promise<InviteRow> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select(`${INVITE_COLUMNS}, workspace:workspaces(name)`)
    .eq("id", inviteId)
    .maybeSingle();
  if (!data) throw new InviteDeliveryError(404, "not_found");
  const row = data as InviteRow & { workspace?: { name: string } | null };
  if (row.accepted_at) {
    throw new InviteDeliveryError(409, "already_accepted", "That invitation was already accepted.");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new InviteDeliveryError(409, "expired", "That invitation has expired — issue a new one.");
  }

  // An owner invitation is somebody being handed a workspace, so it gets the
  // "it's ready, start using it" voice; anything else is a colleague being
  // added to a team that already exists.
  const delivery = await sendWorkspaceInviteEmail({
    email: row.email,
    inviteToken: row.token,
    workspaceName: row.workspace?.name ?? "Bcontext",
    role: row.role,
    variant: row.role === "owner" ? "owner" : "member",
  });

  const { data: updated } = await admin
    .from("workspace_invites")
    .update({
      delivery_state: delivery.status === "sent" ? "sent" : "failed",
      delivery_at: new Date().toISOString(),
      delivery_error: delivery.error,
    })
    .eq("id", inviteId)
    .select(INVITE_COLUMNS)
    .single();
  return updated as InviteRow;
}
