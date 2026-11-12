import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Chip, Separator } from "@heroui/react";
import { apiJson, ApiError } from "@/web/api-client";
import type { AdminWorkspaceMember } from "@bcontext-dev/contract/admin-workspaces";
import {
  formatUsd,
  type AdminWorkspaceAiSpend,
  type AdminWorkspaceDetailWithSpend,
} from "../ai-spend";
import { AdminPage } from "@/components/admin/admin-shell";
import { Empty, Section, Stat } from "@/components/admin/detail-ui";
import { InviteControls } from "./invite-controls";
import { InviteForm } from "./invite-form";
import { RenameForm } from "./rename-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Workspace — Bcontext",
};

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

const NUMBER = new Intl.NumberFormat("en");

/** Fixed locale: the server and the browser must agree or hydration breaks. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** How old something is, in days — the figure that says whether "nothing
 *  yet" is a worry or simply early. */
function age(iso: string): string {
  const d = daysSince(iso);
  if (d <= 0) return "today";
  return `${NUMBER.format(d)} ${d === 1 ? "day" : "days"} old`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return day(iso);
}

/**
 * One workspace's page: what it is, what its AI calls cost, who is in, and
 * everything ever sent to it.
 *
 * The workspace itself leads because every other section is a question about
 * it, and the one edit the panel makes to it — the name — sits there too.
 * The people are above the invitations because an owner who never signed in
 * is the way onboarding fails silently, and the invitations are last because
 * they are the record of what was already tried.
 */
export default async function AdminWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let workspace: AdminWorkspaceDetailWithSpend;
  try {
    workspace = await apiJson<AdminWorkspaceDetailWithSpend>(
      `/api/admin/workspaces/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const invites = [...workspace.invites].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  const neverSignedIn = workspace.members.filter(
    (m) => m.last_sign_in_at === null,
  ).length;
  const openInvites = workspace.pending_invite_count;

  return (
    <AdminPage title={workspace.name}>
      <Link
        href={"/admin/workspaces" as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft size={12} /> All workspaces
      </Link>

      {/* The address as members and agents use it. Printed, not linked: the
          operator is rarely a member, and a link that opens a 404 says
          nothing true about the workspace. */}
      <div className="mono mb-4 text-[11px] text-[var(--ink-mute)]" style={mono}>
        /w/{workspace.slug}
      </div>

      <Section
        title="Workspace"
        hint="What it holds and whether it moves. The name can change; the address is fixed from the day it was created."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Nodes"
            value={NUMBER.format(workspace.node_count)}
            hint="in total"
          />
          <Stat
            label="Members"
            value={NUMBER.format(workspace.member_count)}
            hint={
              openInvites === 0
                ? "no invitation open"
                : `${NUMBER.format(openInvites)} ${openInvites === 1 ? "invitation" : "invitations"} open`
            }
          />
          <Stat
            label="Last activity"
            value={ago(workspace.last_activity_at)}
            hint={
              workspace.last_activity_at
                ? "the latest thing recorded here"
                : "nothing recorded yet"
            }
          />
          <Stat
            label="Created"
            value={day(workspace.created_at)}
            hint={age(workspace.created_at)}
          />
        </div>

        <div className="mt-3 text-[11.5px] text-[var(--ink-3)]">
          {/* Who to talk to is the first thing an operator looks for on this
              page, so it is said in a sentence rather than left for them to
              find among the members below. */}
          {workspace.owner_emails.length === 0 ? (
            "No owner yet — the invitation below is still open."
          ) : (
            <>
              {workspace.owner_emails.length === 1 ? "Owner" : "Owners"}:{" "}
              <span className="text-[var(--ink-2)]" style={mono}>
                {workspace.owner_emails.join(", ")}
              </span>
            </>
          )}
        </div>

        <div className="mt-5">
          <RenameForm
            key={workspace.name}
            workspaceId={workspace.id}
            name={workspace.name}
          />
        </div>
      </Section>

      <Section
        title="AI spend"
        hint={
          workspace.ai_spend
            ? "What every model call cost, summed from the usage ledger: the gateway's own figure per call, or the per-model price table when it reports none. This is the number to check against the gateway's invoice."
            : "The usage ledger could not be read, so nothing here is a figure."
        }
      >
        <AiSpendPanel spend={workspace.ai_spend ?? null} />
      </Section>

      <Section
        title="People"
        hint={
          neverSignedIn > 0
            ? `${neverSignedIn} of ${workspace.members.length} accepted and never signed in — that is where this workspace is stuck.`
            : "Everyone who accepted has signed in at least once."
        }
      >
        {workspace.members.length === 0 ? (
          <Empty>
            Nobody has accepted yet. The workspace exists and the invitation
            below is still open.
          </Empty>
        ) : (
          <div className="rounded-md border border-[var(--line)]">
            {workspace.members.map((m) => (
              <MemberRow key={m.user_id} member={m} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Invitations"
        hint="Everything ever sent, accepted ones included: an invitation that vanishes on acceptance leaves no record of what was sent to whom. A link lives 14 days; revoking kills it immediately."
      >
        {invites.length === 0 ? (
          <Empty>Nothing has been sent.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {invites.map((invite) => (
              <InviteControls
                key={invite.id}
                invite={invite}
                workspaceId={workspace.id}
              />
            ))}
          </div>
        )}

        <Separator className="my-5" />

        <h3 className="text-[12.5px] font-medium text-[var(--ink)]">
          Invite someone else
        </h3>
        <div className="mt-3">
          <InviteForm workspaceId={workspace.id} />
        </div>
      </Section>
    </AdminPage>
  );
}

/**
 * One person in the workspace and how far they got.
 *
 * Whether they ever set a password and whether they ever signed in ride on
 * the member itself rather than being joined in from the accounts list, which
 * arrives one page at a time and would silently mark everybody past the first
 * fifty as unknown. The two are told apart because they are different
 * failures: no password means the invitation never landed, no sign-in means
 * it landed and they never came back.
 */
function MemberRow({ member: m }: { member: AdminWorkspaceMember }) {
  const signedIn = m.last_sign_in_at;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link
          href={`/admin/users/${m.user_id}` as Route}
          className="truncate text-[12.5px] text-[var(--ink)] underline-offset-2 hover:underline"
        >
          {m.email ?? m.user_id}
        </Link>
        <Chip size="sm" variant="secondary" className="text-[10px]">
          <Chip.Label>{m.role}</Chip.Label>
        </Chip>
        {!m.confirmed ? (
          <Chip size="sm" color="warning" className="text-[10px]">
            <Chip.Label>invited, no password</Chip.Label>
          </Chip>
        ) : !signedIn ? (
          <Chip size="sm" color="warning" className="text-[10px]">
            <Chip.Label>never signed in</Chip.Label>
          </Chip>
        ) : null}
      </div>
      <div className="text-[10.5px] text-[var(--ink-mute)]" style={mono}>
        {m.joined_at ? `joined ${day(m.joined_at)}` : "joined —"}
        {signedIn ? ` · last seen ${ago(signedIn)}` : " · no sign-in"}
      </div>
    </div>
  );
}

/**
 * The four figures of the money question: the last 30 days, everything
 * ever, how many calls that was, and how many of them were priced at $0
 * despite consuming tokens. The last one is the accounting's own alarm — a
 * model missing from the price table — and reads as danger when it is not
 * zero, because it means the other three are too low.
 */
function AiSpendPanel({ spend }: { spend: AdminWorkspaceAiSpend | null }) {
  if (!spend) {
    return <Empty>The usage ledger is unavailable.</Empty>;
  }
  if (spend.total_events === 0) {
    return <Empty>No model call has been made in this workspace.</Empty>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="Last 30 days"
        value={formatUsd(spend.last_30d_usd)}
        hint={`${NUMBER.format(spend.last_30d_events)} ${spend.last_30d_events === 1 ? "call" : "calls"}`}
      />
      <Stat
        label="All time"
        value={formatUsd(spend.total_usd)}
        hint={`${NUMBER.format(spend.total_events)} ${spend.total_events === 1 ? "call" : "calls"}`}
      />
      <Stat
        label="Per call · 30d"
        value={
          spend.last_30d_events > 0
            ? formatUsd(spend.last_30d_usd / spend.last_30d_events)
            : "—"
        }
        hint="average, all surfaces"
      />
      <div
        className={
          spend.unpriced_events > 0
            ? "rounded-md border border-[var(--danger,#dc2626)] px-3 py-2.5"
            : "rounded-md border border-[var(--line)] px-3 py-2.5"
        }
      >
        <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
          Unpriced calls
        </div>
        <div
          className={
            spend.unpriced_events > 0
              ? "mt-1 text-[22px] leading-none text-[var(--danger,#dc2626)]"
              : "mt-1 text-[22px] leading-none text-[var(--ink)]"
          }
          style={mono}
        >
          {NUMBER.format(spend.unpriced_events)}
        </div>
        <div className="mt-1 text-[10.5px] text-[var(--ink-3)]">
          {spend.unpriced_events > 0
            ? "consumed tokens, recorded at $0: a model the price table does not know"
            : "every call that consumed tokens was priced"}
        </div>
      </div>
    </div>
  );
}
