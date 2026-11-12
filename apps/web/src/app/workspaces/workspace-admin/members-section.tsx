"use client";

/**
 * Everyone in the workspace, as one roster. Rendered by
 * `workspace-admin-modal.tsx` from `GET /api/workspaces/<slug>/members`.
 *
 * Clicking somebody opens them in place (`member-detail.tsx`) — their role,
 * the agents they connected here, and removing them are one screen, because
 * those are one decision and a tab per verb makes the reader assemble it.
 * Only someone who manages the workspace (`can_manage`) can open a person;
 * everybody else reads the roster as it is.
 *
 * Membership is per workspace, so there is no "which workspaces" here: being
 * on this list is the access.
 */

import { useMemo, useState } from "react";
import { ChevronRight, Mail, UserPlus } from "lucide-react";
import {
  Button,
  Label,
  ListBox,
  SearchField,
  Select,
  Table,
} from "@heroui/react";
import type {
  InviteRole,
  WorkspaceMember,
  WorkspaceMembersResponse,
} from "@bcontext-dev/contract/workspaces";
import { PersonAvatar } from "@/components/person-avatar";
import { NoRows } from "@/components/admin/list-ui";
import { MemberDetail } from "./member-detail";
import {
  RoleChip,
  SectionHead,
  StatusChip,
  relAgo,
  type PanelSection,
} from "./panel-ui";

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

/** Where somebody has got to, as the filter names it. */
type Status = "active" | "never-signed-in" | "invited";

function statusOf(member: WorkspaceMember): Status {
  if (!member.confirmed) return "invited";
  if (!member.last_sign_in_at) return "never-signed-in";
  return "active";
}

const STATUS_LABELS: Record<Status, string> = {
  active: "Active",
  "never-signed-in": "Never signed in",
  invited: "Invited",
};

/** How a person reads in a list: their name, or the address until they give one. */
function label(member: { name: string | null; email: string | null }): string {
  return member.name?.trim() || member.email || "Someone without an address";
}

export function MembersSection({
  slug,
  workspaceName,
  roster,
  onChanged,
  onGo,
}: {
  slug: string;
  workspaceName: string;
  roster: WorkspaceMembersResponse;
  onChanged: () => void;
  onGo: (section: PanelSection) => void;
}) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const canManage = roster.can_manage;

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return roster.members
      .filter((m) => {
        if (role && m.role !== role) return false;
        if (status && statusOf(m) !== status) return false;
        if (!needle) return true;
        return (
          (m.name ?? "").toLowerCase().includes(needle) ||
          (m.email ?? "").toLowerCase().includes(needle)
        );
      })
      // Seniority first, then alphabetically: someone scanning a roster is
      // usually looking for who can change things.
      .toSorted((a, b) => {
        const seniority = ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
        return seniority !== 0 ? seniority : label(a).localeCompare(label(b));
      });
  }, [roster.members, q, role, status]);

  const filtered = q.trim() !== "" || role !== "" || status !== "";

  const open =
    canManage && openUserId
      ? roster.members.find((m) => m.user_id === openUserId) ?? null
      : null;

  if (roster.demo) {
    return (
      <div>
        <SectionHead title="Members" hint={`Everyone who works in ${workspaceName}.`} />
        <p className="text-[13px] text-muted">
          This is a demo workspace: it has no roster, and nobody can be invited to it.
        </p>
      </div>
    );
  }

  if (open) {
    return (
      <MemberDetail
        slug={slug}
        workspaceName={workspaceName}
        member={open}
        onBack={() => setOpenUserId(null)}
        onChanged={onChanged}
      />
    );
  }

  return (
    <div>
      <SectionHead
        title="Members"
        hint={`Everyone who works in ${workspaceName}. An agent acts on its owner's behalf, so it is listed under the person who connected it.`}
        action={
          canManage ? (
            <Button size="sm" onPress={() => onGo("invitations")}>
              <UserPlus size={14} /> Invite someone
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchField
          aria-label="Search people"
          value={q}
          onChange={setQ}
          variant="secondary"
          className="min-w-56 flex-1"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Name or email" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Picker
          label="Role"
          value={role}
          onChange={setRole}
          items={[
            { id: "", label: "Any role" },
            ...ROLES.map((r) => ({ id: r, label: r[0]!.toUpperCase() + r.slice(1) })),
          ]}
        />
        <Picker
          label="Status"
          value={status}
          onChange={setStatus}
          items={[
            { id: "", label: "Any status" },
            { id: "active", label: STATUS_LABELS.active },
            { id: "never-signed-in", label: STATUS_LABELS["never-signed-in"] },
            { id: "invited", label: STATUS_LABELS.invited },
          ]}
        />
      </div>

      {people.length === 0 ? (
        <NoRows
          title={filtered ? "Nobody matches" : "Nobody has joined yet"}
          description={
            filtered
              ? "No one in this workspace matches these filters."
              : "People arrive by invitation. Create one and pass on the link."
          }
          onClear={
            filtered
              ? () => {
                  setQ("");
                  setRole("");
                  setStatus("");
                }
              : undefined
          }
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content
              aria-label={`People in ${workspaceName}`}
              className="min-w-[560px]"
              onRowAction={canManage ? (key) => setOpenUserId(String(key)) : undefined}
            >
              <Table.Header>
                <Table.Column isRowHeader>Person</Table.Column>
                <Table.Column>Role</Table.Column>
                <Table.Column>Last seen</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column> </Table.Column>
              </Table.Header>
              <Table.Body>
                {people.map((member) => (
                  <Table.Row
                    key={member.user_id}
                    id={member.user_id}
                    className={canManage ? "avatar-wake cursor-pointer" : "avatar-wake"}
                  >
                    <Table.Cell>
                      <span className="flex items-center gap-2.5">
                        <PersonAvatar
                          user={{ id: member.user_id, email: member.email }}
                          size={28}
                          animate="hover"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] text-foreground">
                            {label(member)}
                            {member.is_you ? <span className="ml-1.5 text-muted">(you)</span> : null}
                          </span>
                          {member.name && member.email ? (
                            <span className="truncate text-[11.5px] text-muted">{member.email}</span>
                          ) : null}
                        </span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <RoleChip role={member.role} />
                    </Table.Cell>
                    <Table.Cell className="text-[12.5px] text-muted">
                      {relAgo(member.last_sign_in_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip confirmed={member.confirmed} lastSignInAt={member.last_sign_in_at} />
                    </Table.Cell>
                    <Table.Cell>
                      {canManage ? <ChevronRight size={14} className="text-muted" /> : null}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      {canManage && roster.invites.length > 0 ? (
        <button
          type="button"
          onClick={() => onGo("invitations")}
          className="mt-4 flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface/60 px-4 py-3 text-left hover:border-[var(--line-strong)]"
        >
          <Mail size={15} className="shrink-0 text-muted" />
          <span className="flex-1 text-[13px] text-foreground">
            {roster.invites.length === 1
              ? "One invitation is still outstanding"
              : `${roster.invites.length} invitations are still outstanding`}
          </span>
          <ChevronRight size={14} className="text-muted" />
        </button>
      ) : null}
    </div>
  );
}
/**
 * A narrowing that reads as its own value. Local rather than the URL-driven
 * one in `components/admin/list-ui`: this list lives inside a dialog, and a
 * filter that rewrote the hub's address behind it would survive the dialog
 * closing.
 */
function Picker({
  label: name,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  const ALL = "__all__";
  return (
    <Select
      aria-label={name}
      variant="secondary"
      className="w-40 shrink-0"
      selectedKey={value === "" ? ALL : value}
      onSelectionChange={(key) => onChange(key === ALL || key === null ? "" : String(key))}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id || ALL} id={item.id || ALL} textValue={item.label}>
              <Label>{item.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
