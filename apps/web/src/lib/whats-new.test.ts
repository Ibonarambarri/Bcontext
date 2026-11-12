import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "@bcontext-dev/contract/activity";
import {
  DEFAULT_LOOKBACK_DAYS,
  badgeLabel,
  groupByActor,
  groupIngestBatches,
  ingestBatchTitle,
  isOwnChange,
  newChanges,
  newDecisions,
  newestTs,
  pendingReviews,
  sinceFor,
} from "./whats-new";

let seq = 0;
function entry(over: Partial<ActivityEntry> & { actorKind?: "human" | "agent" | "system"; actorId?: string; actorName?: string } = {}): ActivityEntry {
  const { actorKind = "agent", actorId = "agent-1", actorName = "Claude Code", ...rest } = over;
  seq += 1;
  return {
    id: `e${seq}`,
    ts: `2026-11-10T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    kind: "update",
    action: "updated",
    node_id: "n1",
    node_title: "Node one",
    node_kind: "doc",
    block_id: null,
    summary: null,
    actor_kind: actorKind,
    actor_id: actorId,
    actor_principal_id: actorId,
    actor_label: actorName,
    actor: { kind: actorKind, id: actorId, name: actorName },
    correlation_id: null,
    source: "mcp",
    tag_ids: [],
    tag_slugs: [],
    before: null,
    after: null,
    snapshot_state: "available",
    strategic: false,
    affected_relations: [],
    provenance: { via: "mcp", sources: [], references: [] },
    review: null,
    revert: { available: false, reason: "n/a" },
    audit: null,
    ...rest,
  };
}

describe("sinceFor", () => {
  it("uses the stored mark when there is one", () => {
    expect(sinceFor("2026-11-01T00:00:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("looks back the default window on a first visit or a garbled mark", () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    const expected = new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
    expect(sinceFor(null, now)).toBe(expected);
    expect(sinceFor("not a date", now)).toBe(expected);
  });
});

describe("what counts as new", () => {
  it("never shows the viewer their own web edits, but does show their agents'", () => {
    const mine = entry({ actorKind: "human", actorId: "me" });
    const someoneElse = entry({ actorKind: "human", actorId: "colleague" });
    const agent = entry({ actorKind: "agent", actorId: "me" });
    expect(isOwnChange(mine, "me")).toBe(true);
    expect(newChanges([mine, someoneElse, agent], "me")).toEqual([someoneElse, agent]);
  });

  it("keeps everything when the viewer is unknown", () => {
    const mine = entry({ actorKind: "human", actorId: "me" });
    expect(newChanges([mine], null)).toEqual([mine]);
  });
});

describe("needs review", () => {
  it("lists each newly created decision or ADR once", () => {
    const decision = entry({ kind: "create", action: "created", node_id: "d1", node_kind: "decision" });
    const adr = entry({ kind: "create", action: "created", node_id: "a1", node_kind: "adr" });
    const edited = entry({ kind: "update", node_id: "d2", node_kind: "decision" });
    const task = entry({ kind: "create", node_id: "t1", node_kind: "task" });
    const again = entry({ kind: "create", node_id: "d1", node_kind: "decision" });
    expect(newDecisions([decision, adr, edited, task, again]).map((e) => e.node_id)).toEqual(["d1", "a1"]);
  });

  it("picks the changes whose review is still pending", () => {
    const pending = entry({ review: { status: "pending", label: "Proposal", review_url: null } });
    const accepted = entry({ review: { status: "accepted", label: "Proposal", review_url: null } });
    expect(pendingReviews([pending, accepted, entry()])).toEqual([pending]);
  });
});

describe("groupByActor", () => {
  it("groups by actor, then by node, newest first, with the latest title", () => {
    const a1 = entry({ ts: "2026-11-10T10:00:00.000Z", node_id: "n1", node_title: "Old name", action: "created" });
    const a2 = entry({ ts: "2026-11-10T11:00:00.000Z", node_id: "n1", node_title: "New name", action: "renamed" });
    const a3 = entry({ ts: "2026-11-10T09:00:00.000Z", node_id: "n2", node_title: "Other" });
    const h1 = entry({ ts: "2026-11-10T12:00:00.000Z", actorKind: "human", actorId: "ana", actorName: "Ana", node_id: "n3", node_title: "Ana's" });
    const groups = groupByActor([a3, h1, a2, a1]);

    expect(groups.map((g) => g.name)).toEqual(["Ana", "Claude Code"]);
    const agent = groups[1]!;
    expect(agent.count).toBe(3);
    expect(agent.latest).toBe("2026-11-10T11:00:00.000Z");
    expect(agent.nodes.map((n) => n.node_id)).toEqual(["n1", "n2"]);
    expect(agent.nodes[0]).toMatchObject({ title: "New name", actions: ["created", "renamed"] });
    expect(agent.nodes[0]!.entries).toHaveLength(2);
  });

  it("keeps a workspace event with no node as its own row", () => {
    const event = entry({ node_id: null, node_title: null, summary: "Member invited" });
    const [group] = groupByActor([event]);
    expect(group!.nodes[0]).toMatchObject({ node_id: null, title: "Member invited" });
  });
});

describe("badge", () => {
  it("shows nothing at zero and caps past a page", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(7)).toBe("7");
    expect(badgeLabel(140)).toBe("99+");
    expect(badgeLabel(12, true)).toBe("99+");
  });

  it("finds the newest timestamp", () => {
    expect(newestTs([])).toBeNull();
    expect(newestTs([entry({ ts: "2026-11-01T00:00:00.000Z" }), entry({ ts: "2026-11-03T00:00:00.000Z" })])).toBe("2026-11-03T00:00:00.000Z");
  });
});

describe("ingest syncs", () => {
  const ingest = (n: number, over: Partial<ActivityEntry> = {}) =>
    entry({ actorKind: "system", actorId: undefined, actorName: "System", node_id: `rec-${n}`, node_title: `Account ${n}`, source: "ingest:account", provenance: { via: "ingest", sources: [], references: [] }, ...over });

  it("folds one sync into one entry, and leaves everything else to the actor groups", () => {
    const sync = Array.from({ length: 95 }, (_, i) => ingest(i, { correlation_id: "sync-1", kind: i < 3 ? "create" : "update" }));
    const agent = entry({ node_id: "doc-1" });
    const { batches, rest } = groupIngestBatches([...sync, agent]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ record_type: "account", created: 3, updated: 92 });
    expect(batches[0]!.entries).toHaveLength(95);
    expect(ingestBatchTitle(batches[0]!)).toBe("Ingest: 3 records created, 92 updated");
    expect(rest).toEqual([agent]);
    expect(ingestBatchTitle({ created: 0, updated: 95, other: 0 })).toBe("Ingest: 95 records updated");
  });

  it("tells two syncs apart by request, or by a gap when the rows carry no request id", () => {
    expect(groupIngestBatches([ingest(1, { correlation_id: "a" }), ingest(2, { correlation_id: "b" })]).batches).toHaveLength(2);
    const at = (iso: string, n: number) => ingest(n, { ts: iso });
    const { batches } = groupIngestBatches([
      at("2026-11-10T10:00:00.000Z", 1),
      at("2026-11-10T10:01:00.000Z", 2),
      at("2026-11-10T12:00:00.000Z", 3),
    ]);
    expect(batches.map((batch) => batch.entries.length)).toEqual([1, 2]);
  });
});
