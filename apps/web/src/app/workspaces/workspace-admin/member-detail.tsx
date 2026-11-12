"use client";

/**
 * One member, and everything an administrator does to them: their role, the
 * agents they connected to this workspace, and removing them. Opened from the
 * roster (`members-section.tsx`), only for someone who manages the workspace.
 *
 * Reads `GET /api/workspaces/<slug>/members/<userId>` (`WorkspaceMemberDetail`),
 * writes `PATCH` (`{ role }`) and `DELETE` on the same path. The row that
 * opened this screen draws the header, so the name and role are on the page
 * before the read finishes.
 *
 * Must not break: the last owner can neither be demoted nor removed — the
 * detail says so up front (`is_last_owner`) and the API refuses it anyway
 * (409 `last_owner`, whose message is shown verbatim); and nobody changes
 * their own role or removes themselves from here.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, ArrowUpRight, ShieldAlert } from "lucide-react";
import { Alert, Button, Label, ListBox, Select } from "@heroui/react";
import type {
  InviteRole,
  WorkspaceMember,
  WorkspaceMemberDetail,
  WorkspaceMemberPatch,
} from "@bcontext-dev/contract/workspaces";
import { PersonAvatar } from "@/components/person-avatar";
import { ListSkeleton } from "@/components/skeletons";
import { workspaceApiRef, workspacePath } from "@/web/workspace-url";
import {
  AgentRow,
  Block,
  RoleChip,
  StatusChip,
  apiMessage,
  formatDay,
  relAgo,
} from "./panel-ui";

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

const ROLE_MEANING: Record<InviteRole, string> = {
  owner: "Administers the workspace, and cannot be the last one removed.",
  admin: "Administers the workspace: its members, invitations and settings.",
  editor: "Reads and writes everything in the workspace.",
  viewer: "Reads everything in the workspace, and writes nothing.",
};

export function MemberDetail({
  slug,
  workspaceName,
  member,
  onBack,
  onChanged,
}: {
  slug: string;
  workspaceName: string;
  /** The roster row that was clicked — the header before the read lands. */
  member: WorkspaceMember;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<WorkspaceMemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const base = `/api/workspaces/${encodeURIComponent(workspaceApiRef(slug))}/members/${encodeURIComponent(member.user_id)}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't read this person."));
        return;
      }
      setDetail((await res.json()) as WorkspaceMemberDetail);
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A write against the person, followed by a re-read of both this screen
   *  and the roster behind it — they show the same facts. */
  const write = useCallback(
    async (init: RequestInit, fallback: string): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch(base, init);
        if (!res.ok) {
          setError(await apiMessage(res, fallback));
          return false;
        }
        onChanged();
        return true;
      } catch {
        setError("Couldn't reach the server.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [base, onChanged],
  );

  const name = detail?.name ?? member.name ?? member.email ?? "This person";
  const role = detail?.role ?? member.role;

  return (
    <div>
      <Button size="sm" variant="ghost" onPress={onBack} className="mb-4 -ml-2">
        <ArrowLeft size={14} /> All members
      </Button>

      <header className="mb-7 flex flex-wrap items-center gap-3.5">
        <PersonAvatar
          user={{ id: member.user_id, email: detail?.email ?? member.email }}
          size={44}
          animate="always"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-foreground">
            {name}
            {member.is_you ? (
              <span className="ml-2 text-[14px] font-normal text-muted">(you)</span>
            ) : null}
          </h2>
          <p className="truncate text-[13px] text-muted">
            {detail?.email ?? member.email ?? "No address"} · joined{" "}
            {formatDay(detail?.joined_at ?? member.joined_at)} · last seen{" "}
            {relAgo(detail?.last_sign_in_at ?? member.last_sign_in_at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RoleChip role={role} />
          <StatusChip
            confirmed={detail?.confirmed ?? member.confirmed}
            lastSignInAt={detail?.last_sign_in_at ?? member.last_sign_in_at}
          />
        </div>
      </header>

      {error ? (
        <Alert role="alert" status="danger" className="mb-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {!detail ? (
        <ListSkeleton rows={5} label="Reading this person" />
      ) : (
        <>
          <RoleBlock
            detail={detail}
            workspaceName={workspaceName}
            pending={pending}
            onChange={async (next) => {
              const body: WorkspaceMemberPatch = { role: next };
              if (
                await write(
                  {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  },
                  "Couldn't change the role.",
                )
              ) {
                await load();
              }
            }}
          />

          <AgentsBlock detail={detail} slug={slug} />

          <RemoveBlock
            detail={detail}
            workspaceName={workspaceName}
            pending={pending}
            onRemove={() =>
              void write({ method: "DELETE" }, "Couldn't remove this person.").then((ok) => {
                if (ok) onBack();
              })
            }
          />
        </>
      )}
    </div>
  );
}

/* ─── Role ────────────────────────────────────────────────────────────── */

function RoleBlock({
  detail,
  workspaceName,
  pending,
  onChange,
}: {
  detail: WorkspaceMemberDetail;
  workspaceName: string;
  pending: boolean;
  onChange: (role: InviteRole) => Promise<void>;
}) {
  return (
    <Block title="Role" hint={`What they can do in ${workspaceName}.`}>
      <div className="rounded-[10px] border border-border bg-surface/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Workspace role"
            className="w-48"
            isDisabled={pending || detail.is_you || detail.is_last_owner}
            selectedKey={detail.role}
            onSelectionChange={(key) => {
              if (key != null && key !== detail.role) void onChange(String(key) as InviteRole);
            }}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ROLES.map((r) => (
                  <ListBox.Item key={r} id={r} textValue={r}>
                    <Label className="capitalize">{r}</Label>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="min-w-0 flex-1 text-[12.5px] text-muted">{ROLE_MEANING[detail.role]}</p>
        </div>

        {detail.is_you ? (
          <p className="mt-2 text-[12px] text-muted">
            You can&apos;t change your own role. Ask another owner.
          </p>
        ) : detail.is_last_owner ? (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning">
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            The only owner. Make somebody else an owner before changing this, or
            the workspace is left with nobody who can administer it.
          </p>
        ) : null}
      </div>
    </Block>
  );
}

/* ─── Agents ──────────────────────────────────────────────────────────── */

/**
 * What this person connected to the workspace. An agent reads with its
 * owner's access, so it can never reach further than they do. Listed here,
 * managed on the workspace's Agents page — one place disconnects agents, and
 * it is the one that also shows the sessions and tokens behind them.
 */
function AgentsBlock({ detail, slug }: { detail: WorkspaceMemberDetail; slug: string }) {
  return (
    <Block
      title="Agents"
      hint="Everything non-human this person connected here. It reads with their access, so it can never reach further than they do."
      action={
        detail.agents.length > 0 ? (
          <Link
            href={workspacePath(slug, "v/agents") as Route}
            className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-foreground"
          >
            Manage on Agents <ArrowUpRight size={13} />
          </Link>
        ) : undefined
      }
    >
      {detail.agents.length === 0 ? (
        <p className="text-[12.5px] text-muted">They haven&apos;t connected anything yet.</p>
      ) : (
        <div className="divide-y divide-[var(--line)] rounded-[10px] border border-border bg-surface/60">
          {detail.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </Block>
  );
}

/* ─── Removal ─────────────────────────────────────────────────────────── */

function RemoveBlock({
  detail,
  workspaceName,
  pending,
  onRemove,
}: {
  detail: WorkspaceMemberDetail;
  workspaceName: string;
  pending: boolean;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (detail.is_you) {
    return (
      <Block
        title="Leaving"
        hint={`You can't remove yourself from ${workspaceName} here — another owner has to.`}
      >
        <span className="sr-only">No action available.</span>
      </Block>
    );
  }

  return (
    <Block
      title="Remove from the workspace"
      hint={`Takes them out of ${workspaceName}. Agents they connected are disconnected on the Agents page.`}
    >
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="danger" isDisabled={pending} onPress={onRemove}>
            {pending ? "Removing…" : `Remove ${detail.name ?? detail.email ?? "them"}`}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          isDisabled={pending || detail.is_last_owner}
          onPress={() => setConfirming(true)}
        >
          Remove from {workspaceName}
        </Button>
      )}
      {detail.is_last_owner ? (
        <p className="mt-2 text-[12px] text-muted">
          The only owner cannot be removed — the workspace would have nobody who
          can administer it.
        </p>
      ) : null}
    </Block>
  );
}
