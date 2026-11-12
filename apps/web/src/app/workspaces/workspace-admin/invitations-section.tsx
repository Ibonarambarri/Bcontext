"use client";

import { useState } from "react";
import { MailCheck, Send, UserPlus } from "lucide-react";
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@bcontext-dev/contract/utils";
import type {
  CreateWorkspaceInviteBody,
  CreateWorkspaceInviteResult,
  InviteEmailStatus,
  InviteRole,
  WorkspaceInvite,
} from "@bcontext-dev/contract/workspaces";
import { CopyLink } from "@/components/admin/copy-link";
import { workspaceApiRef } from "@/web/workspace-url";
import { Block, RoleChip, SectionHead, apiMessage, relAgo } from "./panel-ui";

/**
 * The people who have been asked into the workspace but are not in yet.
 * Rendered by `workspace-admin-modal.tsx` for someone who manages the
 * workspace; the list is `WorkspaceMembersResponse.invites`, and the writes
 * are `POST /api/workspaces/<slug>/invites`, `POST …/invites/<id>/email` and
 * `DELETE …/invites/<id>`.
 *
 * They used to live at the bottom of the roster, under the members, which read
 * as "the roster, plus some stragglers". They are not that: a member is a fact
 * about the workspace and an invitation is an open question about it, with
 * its own clock and its own two endings. Giving them a section of their own is
 * what lets this screen say the thing the old tab could not — that the link
 * has not been delivered, and by whom it is waiting to be.
 *
 * The product decision this screen is built around: **creating an invitation
 * sends nothing.** The link is the deliverable, and the administrator decides
 * how it travels — a chat message, a ticket, spoken over a desk. Email is one
 * more channel, chosen per invitation with a button, because it is the one act
 * here that cannot be taken back: once a stranger's inbox has the token, no
 * amount of clicking revoke un-sends it. Revoking kills the token; it does not
 * kill the email.
 */

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

/**
 * What came back from the one irreversible button, said plainly: "skipped" on
 * its own reads like a bug the reader should report, when it means the
 * deployment has no mail sender and the link is theirs to pass on by hand.
 */
const EMAIL_STATUS_LABEL: Record<InviteEmailStatus, string> = {
  sent: "Emailed",
  skipped: "Not emailed — no mail sender is configured",
  error: "Email failed",
};

/** Under two days left is a different sentence from "invited this morning". */
const EXPIRING_SOON_MS = 2 * 86_400_000;

export function InvitationsSection({
  slug,
  workspaceName,
  invites,
  onChanged,
}: {
  slug: string;
  workspaceName: string;
  invites: WorkspaceInvite[];
  onChanged: () => void;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceApiRef(slug))}/invites`;
  return (
    <div>
      <SectionHead
        title="Invitations"
        hint={`People asked into ${workspaceName} who have not accepted yet. Creating one sends nothing — you get a link to pass on, and emailing it is a separate step.`}
      />

      <InviteForm base={base} onChanged={onChanged} />

      <Block
        title="Waiting to accept"
        hint="Each one expires on its own clock. Revoking kills the link; it does not recall an email already sent."
      >
        {invites.length === 0 ? (
          <EmptyState size="sm">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <MailCheck size={18} />
              </EmptyState.Media>
              <EmptyState.Title>Nobody is waiting</EmptyState.Title>
              <EmptyState.Description className="max-w-[420px]">
                Everyone who has been invited is already a member. Invite
                somebody above when that changes.
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {invites.map((invite) => (
              <InviteCard
                key={invite.id}
                base={base}
                invite={invite}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </Block>
    </div>
  );
}

/* ─── Ask somebody in ─────────────────────────────────────────────────── */

function InviteForm({
  base,
  onChanged,
}: {
  /** `/api/workspaces/<slug>/invites`. */
  base: string;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WorkspaceInvite | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body: CreateWorkspaceInviteBody = { email: trimmed, role };
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't create the invitation."));
        return;
      }
      const json = (await res.json()) as CreateWorkspaceInviteResult;
      // The fresh link is held here as well as in the list below, because the
      // list is a re-read and the one thing that must not be missed is the
      // link that has just come into existence.
      setCreated(json.invite);
      setEmail("");
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Block
      title="Invite someone"
      hint="An address, and what they will be able to do in the workspace."
    >
      <form
        onSubmit={submit}
        className="rounded-[10px] border border-border bg-surface/60 p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
          <TextField
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="off"
            isDisabled={pending}
            fullWidth
          >
            <Label>Email address</Label>
            <Input placeholder="colleague@company.com" />
          </TextField>

          <Select
            value={role}
            onChange={(key) => {
              if (key != null) setRole(String(key) as InviteRole);
            }}
          >
            <Label>Role</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ROLES.map((r) => (
                  <ListBox.Item key={r} id={r} textValue={r}>
                    <span className="capitalize">{r}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        {error ? (
          <Alert role="alert" status="danger" className="mt-4">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" isPending={pending} isDisabled={pending}>
            <UserPlus size={14} />
            {pending ? "Creating…" : "Create invitation"}
          </Button>
          <span className="text-[12px] text-muted">
            No email goes out. You get a link.
          </span>
        </div>

        {created ? (
          <div className="mt-4 space-y-2 rounded-[10px] border border-border bg-[var(--paper)] p-3">
            <div className="text-[13px] text-foreground">
              Invitation for{" "}
              <span className="font-medium">{created.email}</span> — nothing has
              been sent yet.
            </div>
            <CopyLink url={created.url} />
          </div>
        ) : null}
      </form>
    </Block>
  );
}

/* ─── One open question ───────────────────────────────────────────────── */

function InviteCard({
  base: listBase,
  invite,
  onChanged,
}: {
  base: string;
  invite: WorkspaceInvite;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `${listBase}/${encodeURIComponent(invite.id)}`;

  // An invitation that is nearly out of time is a different object from a
  // fresh one — it is about to need re-issuing — so it says so rather than
  // leaving the reader to subtract two dates in their head.
  const expiresAt = Date.parse(invite.expires_at);
  const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : null;
  const expired = remaining != null && remaining <= 0;
  const expiringSoon =
    remaining != null && remaining > 0 && remaining < EXPIRING_SOON_MS;

  async function call(path: string, method: string, fallback: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        setError(await apiMessage(res, fallback));
        return;
      }
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-[10px] border bg-surface/60 px-4 py-3.5",
        expired ? "border-danger/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">
              {invite.email}
            </span>
            <RoleChip role={invite.role} />
            {expired ? (
              <Chip size="sm" variant="soft" color="danger">
                <Chip.Label>Expired</Chip.Label>
              </Chip>
            ) : expiringSoon ? (
              <Chip size="sm" variant="soft" color="warning">
                <Chip.Label>Expires soon</Chip.Label>
              </Chip>
            ) : null}
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            Invited {relAgo(invite.created_at)} ·{" "}
            {expired
              ? `expired ${relAgo(invite.expires_at)}`
              : `expires ${relAgo(invite.expires_at)}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Emailing is the one act here that cannot be taken back, so it
              stays a deliberate second step rather than a side effect of
              creating the invitation. */}
          <Button
            size="sm"
            variant="outline"
            isDisabled={pending || expired}
            onPress={() =>
              void call(`${base}/email`, "POST", "Couldn't email it.")
            }
          >
            <Send size={13} />
            Email it
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={pending}
            onPress={() => void call(base, "DELETE", "Couldn't revoke it.")}
          >
            Revoke
          </Button>
        </div>
      </div>

      {/* The link is the deliverable, so it is the one address this product
          still prints on screen. */}
      <CopyLink url={invite.url} />

      {invite.email_status ? (
        <p
          className={cn(
            "text-[12px]",
            invite.email_status === "error" ? "text-danger" : "text-muted",
          )}
        >
          {EMAIL_STATUS_LABEL[invite.email_status]}
          {invite.email_sent_at ? ` ${relAgo(invite.email_sent_at)}` : ""}
          {invite.email_error ? ` — ${invite.email_error}` : ""}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
