"use client";

/**
 * What the workspace consumes this month, from
 * `GET /api/workspaces/<slug>/usage` (`WorkspaceUsage`). Rendered by
 * `workspace-admin-modal.tsx` for someone who manages the workspace.
 *
 * Measured, never priced: a self-hosted instance has no ceilings, only
 * numbers an administrator reads. Read-only on purpose — nothing here writes.
 *
 * The figures lead because they are read in a glance and give everything
 * below them a denominator; the writes are split by who made them (people,
 * agents) and deliberately not summed, because a migration or backfill writes
 * as `system` and crediting it to either side would claim work nobody did.
 * The MCP calls come by tool, because `ping` is noise and `nodes(op=search)`
 * is a retrieval — the total alone says nothing about how the context is read.
 *
 * Must not break: an unavailable read says so, and is never drawn as zeros —
 * "we could not ask" and "nothing happened" are different statements.
 */

import { Table } from "@heroui/react";
import type { WorkspaceUsage } from "@bcontext-dev/contract/workspaces";
import { Block, Figure, SectionHead, formatInt, monthLabel } from "./panel-ui";

export function UsageSection({
  usage,
  unavailable,
}: {
  usage: WorkspaceUsage | null;
  /** The read failed (or was refused), as opposed to still being on its way. */
  unavailable: boolean;
}): React.JSX.Element {
  if (!usage) {
    return (
      <div>
        <SectionHead title="Usage" hint="What this workspace consumes this month." />
        <p className="text-[13px] text-muted">
          {unavailable
            ? "The usage counters couldn't be read just now."
            : "Reading the counters…"}
        </p>
      </div>
    );
  }

  const tools = usage.mcp_calls.by_tool;

  return (
    <div>
      <SectionHead
        title="Usage"
        hint={`What this workspace consumed in ${monthLabel(usage.period)}. Counted, never priced.`}
      />

      <Block title="At a glance">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Figure value={formatInt(usage.member_count)} label={usage.member_count === 1 ? "Member" : "Members"} />
          <Figure value={formatInt(usage.agent_count)} label={usage.agent_count === 1 ? "Agent" : "Agents"} />
          <Figure value={formatInt(usage.nodes_total)} label="Nodes in total" />
          <Figure value={formatInt(usage.mcp_calls.total)} label="MCP calls" />
        </div>
      </Block>

      <Block
        title="Context"
        hint="Nodes created and edited this month, and the writes split by who made them. People and agents do not add up to every write: system jobs write too."
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Figure value={formatInt(usage.nodes_created)} label="Nodes created" />
          <Figure value={formatInt(usage.nodes_edited)} label="Nodes edited" />
          <Figure value={formatInt(usage.writes_by_people)} label="Writes by people" />
          <Figure value={formatInt(usage.writes_by_agents)} label="Writes by agents" />
        </div>
      </Block>

      <Block title="AI and meetings" hint="Calls to a model on someone's behalf, and recorded meeting time.">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Figure value={formatInt(usage.ai_queries)} label="AI queries" />
          <Figure value={formatInt(usage.meeting_minutes)} label="Meeting minutes" />
        </div>
      </Block>

      <Block
        title="What agents read"
        hint="MCP tool calls this month, busiest first — the only measure of how much of this workspace's context is read."
      >
        {tools.length === 0 ? (
          <p className="text-[12.5px] text-muted">No agent has called a tool here this month.</p>
        ) : (
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="MCP calls by tool" className="min-w-[360px]">
                <Table.Header>
                  <Table.Column isRowHeader>Tool</Table.Column>
                  <Table.Column>Calls</Table.Column>
                </Table.Header>
                <Table.Body>
                  {tools.map((row) => (
                    <Table.Row key={row.tool} id={row.tool}>
                      <Table.Cell className="font-mono text-[12.5px]">{row.tool}</Table.Cell>
                      <Table.Cell className="tabular-nums">{formatInt(row.calls)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Block>
    </div>
  );
}
