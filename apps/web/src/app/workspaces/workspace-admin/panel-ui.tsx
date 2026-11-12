"use client";

import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { Chip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import type { InviteRole, WorkspaceMemberAgent } from "@bcontext-dev/contract/workspaces";

/**
 * The furniture the workspace panel (`workspace-admin-modal.tsx` and its
 * sections) is made of. Imported only by this folder.
 *
 * It exists for the same reason `components/admin/detail-ui` does — sections
 * that each invented a heading stop looking like one instrument — but it is
 * deliberately quieter than that one. The platform panel is read at speed by
 * one operator who wants density; this is read occasionally by a workspace's
 * owner, and the loud parts of the old tabs (uppercase mono kickers over
 * every group, 10px counters, the workspace's URL printed under its name)
 * were density nobody asked for. What is left is the figure and the sentence
 * that stops it being misread.
 */

/** The sections, re-exported so a section can send the reader to another. */
export type { PanelSection } from "./sections";

/** A titled part of a section. The hint says what it is for, in one line. */
export function Block({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  /** A control that belongs to the block's subject, on the heading's line. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8 last:mb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14.5px] font-semibold text-foreground">{title}</h3>
          {hint ? (
            <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{hint}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The heading a whole section opens with. */
export function SectionHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-muted">{hint}</p>
      </div>
      {action ? <div className="shrink-0 pt-1">{action}</div> : null}
    </header>
  );
}

/**
 * One figure with its name under it.
 *
 * The number leads and is large, because it is what the eye came for; the
 * name is the smaller half. The old panel had this the other way round — a
 * 10px uppercase label above an 18px number — which reads as a form field.
 */
export function Figure({
  value,
  label,
  tone = "default",
}: {
  value: string;
  label: string;
  tone?: "default" | "muted";
}) {
  return (
    <div className="rounded-[10px] border border-border bg-surface/60 px-4 py-3">
      <div
        className={cn(
          "text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums",
          tone === "muted" ? "text-muted" : "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[12.5px] text-muted">{label}</div>
    </div>
  );
}

/** Seniority in the workspace, said the same way everywhere. */
export function RoleChip({ role }: { role: InviteRole | "agent" }) {
  const color =
    role === "owner" ? "accent" : role === "admin" ? "warning" : "default";
  return (
    <Chip size="sm" variant="soft" color={color} className="capitalize">
      <Chip.Label>{role}</Chip.Label>
    </Chip>
  );
}

/**
 * Where somebody has got to, in the order signing up happens: two ways the
 * handover fails, and then the one where it did not. Same three states the
 * platform panel names, because they are the same three facts.
 */
export function StatusChip({
  confirmed,
  lastSignInAt,
}: {
  confirmed: boolean;
  lastSignInAt: string | null;
}) {
  if (!confirmed) {
    return (
      <Chip size="sm" variant="soft" color="warning">
        <Chip.Label>Invited</Chip.Label>
      </Chip>
    );
  }
  if (!lastSignInAt) {
    return (
      <Chip size="sm" variant="soft" color="warning">
        <Chip.Label>Never signed in</Chip.Label>
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="secondary">
      <Chip.Label>Active</Chip.Label>
    </Chip>
  );
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatInt(value: number): string {
  return NUMBER.format(value);
}

/**
 * How long ago, in the coarsest unit that is still true. A fixed locale on
 * the fallback: the server (en-US) and a browser set to Spanish disagree on
 * date order, and a hydration mismatch is worse than an American date.
 */
export function relAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  const ahead = diff < 0;
  const abs = Math.max(1, Math.abs(diff));
  const span =
    abs < 60
      ? "just now"
      : abs < 3600
        ? `${Math.floor(abs / 60)} min`
        : abs < 86_400
          ? `${Math.floor(abs / 3600)} h`
          : abs < 30 * 86_400
            ? `${Math.floor(abs / 86_400)} d`
            : null;
  if (span === null) {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  }
  if (span === "just now") return ahead ? "in a moment" : "just now";
  return ahead ? `in ${span}` : `${span} ago`;
}

/** A date said in full, for the one or two places that want the day itself. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(t);
}

/** `YYYY-MM` as a person says it. */
export function monthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(
    new Date(Number(match[1]), Number(match[2]) - 1, 1),
  );
}

/**
 * The API answers failures with `{ message }` (and older routes `{ error }`).
 * Its refusals are written for the person reading them — the last owner,
 * a taken slug — so they are shown verbatim rather than re-guessed here.
 */
export async function apiMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: unknown; error?: unknown }
    | null;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  return fallback;
}

/**
 * One agent, wherever it is listed: the person's own screen, today.
 *
 * It lives in the shared furniture so a second list of agents in this panel
 * would draw the same row rather than a new one — an agent's reach is the
 * one thing on any screen worth reading twice, and two renderings drift.
 */
export function AgentRow({
  agent,
  action,
}: {
  agent: WorkspaceMemberAgent;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <Bot size={15} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] text-foreground">{agent.name}</span>
          {agent.provider ? (
            <Chip size="sm" variant="secondary">
              <Chip.Label>{agent.provider}</Chip.Label>
            </Chip>
          ) : null}
        </div>
        <div className="mt-0.5 text-[12px] text-muted">
          {agent.last_used_at
            ? `Last used ${relAgo(agent.last_used_at)}`
            : "Never used since it was connected"}
          {" · "}
          {scopeSummary(agent.scopes)}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * An agent's reach in this workspace, in as few words as are true.
 *
 * `admin:*` already contains every other scope, so printing the list beside it
 * is seven tokens hiding the one that matters. Past a handful the list stops
 * being read at all, so it becomes a count — the detail is one click away on
 * the workspace's Agents page.
 */
export function scopeSummary(scopes: string[]): string {
  if (scopes.length === 0) return "no scopes";
  if (scopes.includes("admin:*")) return "full access";
  if (scopes.length <= 3) return scopes.join(" ");
  return `${scopes.slice(0, 2).join(" ")} +${scopes.length - 2} more`;
}
