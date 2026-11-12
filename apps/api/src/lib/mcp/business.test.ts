/**
 * The business layer over MCP, end to end on the demo backend: an admin
 * defines record types and the business model, an agent writes records as
 * ordinary kinds with validated `fields`, filters on them, sees them in
 * `brief`, reads the metrics, and promotes a dataset row into a node.
 *
 * Dataset rows go through a fake pool that understands the keyed-row
 * statements (`datasets/rows.ts`); events and rollups use the demo backend's
 * in-memory store, so the whole loop runs without Postgres.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { setPoolForTests } from "@/lib/queue/db";
import type { Storage } from "@/lib/storage";
import { _resetDemoBusiness, getRecordType } from "@/lib/business/record-types";
import { _resetDemoEvents, insertEvents, loadRollupEvents } from "@/lib/business/events";
import { runBusinessRollup } from "@/lib/business/rollup-job";
import { eraseRecord, upsertDatasetRecords } from "@/lib/business/records";
import { buildMcpServer } from "./server";

type Row = { idx: number; key: string | null; data: Record<string, unknown> };
const stored = new Map<string, Row[]>();

async function runStatement(text: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> {
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
  if (text.includes("pg_advisory_xact_lock") || text.includes("pg_notify")) return { rows: [] };
  const nodeId = String(values[0]);
  const rows = stored.get(nodeId) ?? [];
  if (text.startsWith("select key from")) {
    const keys = values[2] as string[];
    return { rows: rows.filter((r) => r.key !== null && keys.includes(r.key)).map((r) => ({ key: r.key })) };
  }
  if (text.startsWith("update public.dataset_rows")) {
    for (const update of JSON.parse(String(values[2])) as Array<{ key: string; data: Record<string, unknown> }>) {
      const row = rows.find((r) => r.key === update.key)!;
      row.data = { ...row.data, ...update.data };
    }
    return { rows: [] };
  }
  if (text.startsWith("select coalesce(max(idx), -1)")) {
    return { rows: [{ max_idx: rows.length ? Math.max(...rows.map((r) => r.idx)) : -1 }] };
  }
  if (text.startsWith("insert into public.dataset_rows (node_id, workspace_id, idx, key, data)")) {
    stored.set(nodeId, [...rows, ...(JSON.parse(String(values[2])) as Row[])]);
    return { rows: [] };
  }
  if (text.startsWith("insert into")) {
    stored.set(nodeId, [...rows, ...(JSON.parse(String(values[2])) as Row[]).map((r) => ({ ...r, key: null }))]);
    return { rows: [] };
  }
  if (text.includes("count(*)::int as count")) {
    return { rows: [{ count: rows.length, max_idx: rows.length ? Math.max(...rows.map((r) => r.idx)) : null }] };
  }
  if (text.startsWith("select data from") && text.includes("key = $3")) {
    const row = rows.find((r) => r.key === values[2]);
    return { rows: row ? [{ data: row.data }] : [] };
  }
  if (text.startsWith("select data from")) {
    return { rows: rows.slice(0, Number(values[2])).map((r) => ({ data: r.data })) };
  }
  if (text.startsWith("delete from") && text.includes("key = $3")) {
    const kept = rows.filter((r) => r.key !== values[2]);
    stored.set(nodeId, kept);
    return { rows: rows.length > kept.length ? [{ idx: 0 }] : [] };
  }
  if (text.startsWith("delete from")) {
    stored.set(nodeId, []);
    return { rows: [] };
  }
  throw new Error(`unexpected statement: ${text}`);
}

const fakePool = {
  query: (text: string, values: unknown[]) => runStatement(text, values),
  connect: async () => ({
    query: (text: string, values?: unknown[]) => runStatement(text, values ?? []),
    release: () => {},
  }),
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) => (result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
const body = <T = Record<string, unknown>>(result: ToolResult) => JSON.parse(text(result)) as T;

describe("business layer over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;
  let workspaceId: string;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await call(name, args);
    expect(res.isError, text(res)).toBeFalsy();
    return body<T>(res);
  }

  beforeEach(async () => {
    stored.clear();
    _resetDemoBusiness();
    _resetDemoEvents();
    process.env.DATABASE_URL = "postgres://fake/test";
    setPoolForTests(fakePool as never);
    const slug = `mcp-biz-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Denak", slug });
    workspaceId = workspace.id;
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["admin:*"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write", "delete", "admin"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };

    await ok("admin_write", {
      op: "record_type",
      key: "contact",
      definition: { label: "Contact", fields: [{ key: "role", label: "Role", type: "text" }] },
    });
    await ok("admin_write", {
      op: "record_type",
      key: "account",
      definition: {
        label: "Account",
        stage_field: "stage",
        fields: [
          { key: "mrr", label: "MRR", type: "money", required: true, description: "Monthly recurring revenue" },
          { key: "stage", label: "Stage", type: "select", options: ["trial", "customer", "churned"] },
          { key: "seats", label: "Seats", type: "number" },
          { key: "champion", label: "Champion", type: "relation", target: "contact" },
        ],
      },
    });
  });

  afterEach(async () => {
    await close();
    setPoolForTests(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("writes a record type as an ordinary kind, with its fields validated", async () => {
    const contact = await ok<{ id: string }>("nodes_write", { op: "create", kind: "contact", title: "Iker", fields: { role: "CTO" } });
    const created = await ok<{ id: string; node: { kind: string; data: { fields: Record<string, unknown> } } }>("nodes_write", {
      op: "create",
      kind: "account",
      title: "Acme",
      fields: { mrr: { amount: 490, currency: "EUR" }, stage: "customer", champion: contact.id },
    });
    expect(created.node.kind).toBe("account");
    expect(created.node.data.fields).toMatchObject({ stage: "customer", champion: contact.id });

    const bad = await call("nodes_write", { op: "create", kind: "account", title: "Bad", fields: { mrr: 490, stage: "won", mmr: 1 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("field `mrr`");
    expect(text(bad)).toContain("trial | customer | churned");
    expect(text(bad)).toContain("`mmr` is not a field of account");

    const wrongTarget = await call("nodes_write", {
      op: "create", kind: "account", title: "X", fields: { mrr: { amount: 1, currency: "EUR" }, champion: created.id },
    });
    expect(text(wrongTarget)).toContain("expected a contact");

    const unknown = await call("nodes_write", { op: "create", kind: "deal", title: "Big deal" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("record types: contact, account");

    const fieldsOnCore = await call("nodes_write", { op: "create", kind: "doc", title: "Doc", fields: { x: 1 } });
    expect(text(fieldsOnCore)).toContain("core kind");
  });

  it("merges field patches and keeps reserved keys across a data patch", async () => {
    const created = await ok<{ id: string; node: { updated_at: string } }>("nodes_write", {
      op: "create", kind: "account", title: "Acme", fields: { mrr: { amount: 100, currency: "EUR" }, seats: 3 },
    });
    // What an ingest would have stamped.
    const node = (await storage.getNode(created.id))!;
    await storage.updateNode(created.id, { data: { ...node.data, external_id: "acc_1" } });

    await ok("nodes_write", { op: "update", id: created.id, patch: { fields: { seats: 5, stage: "customer" } } });
    // A data patch that knows nothing about records must not lose them.
    await ok("nodes_write", { op: "update", id: created.id, patch: { data: { note: "hello" } } });
    const after = (await storage.getNode(created.id))!;
    expect(after.data).toMatchObject({
      note: "hello",
      external_id: "acc_1",
      fields: { mrr: { amount: 100, currency: "EUR" }, seats: 5, stage: "customer" },
    });

    const clearRequired = await call("nodes_write", { op: "update", id: created.id, patch: { fields: { mrr: null } } });
    expect(text(clearRequired)).toContain("field `mrr`");
  });

  it("lists a record kind with field filters and returns the values", async () => {
    for (const [title, amount, stage] of [["Acme", 500, "customer"], ["Globex", 90, "trial"], ["Initech", 1200, "customer"]] as const) {
      await ok("nodes_write", { op: "create", kind: "account", title, fields: { mrr: { amount, currency: "EUR" }, stage } });
    }
    const list = await ok<{ nodes: Array<{ title: string; fields: { mrr: { amount: number } } }> }>("nodes", {
      op: "list", kind: "account", fields: [{ field: "stage", op: "eq", value: "customer" }, { field: "mrr", op: "gt", value: 600 }],
    });
    expect(list.nodes.map((n) => n.title)).toEqual(["Initech"]);
    expect(list.nodes[0]!.fields.mrr.amount).toBe(1200);

    const badField = await call("nodes", { op: "list", kind: "account", fields: [{ field: "arr", op: "gt", value: 1 }] });
    expect(text(badField)).toContain("no field `arr`");
    const noKind = await call("nodes", { op: "list", fields: [{ field: "stage", op: "eq", value: "x" }] });
    expect(text(noKind)).toContain("need `kind`");
  });

  it("validates view kinds against the workspace", async () => {
    const saved = await call("views_write", {
      op: "create", name: "Accounts", query: { schema_version: 1, kinds: ["account"] }, presentation: { schema_version: 1, renderer: "table" },
    });
    expect(saved.isError).toBeFalsy();
    const typo = await call("views", { op: "query", query: { schema_version: 1, kinds: ["acount"] } });
    expect(typo.isError).toBe(true);
    expect(text(typo)).toContain("account");
  });

  it("puts the business model and a compact record type summary in brief", async () => {
    await ok("admin_write", { op: "set_business", business_model: "b2b", currency: "EUR" });
    const brief = await ok<{ business: { model: string; record_types: Array<{ key: string; fields: string; stages?: string[] }> } }>("brief", {});
    expect(brief.business.model).toBe("b2b");
    const account = brief.business.record_types.find((t) => t.key === "account")!;
    expect(account.fields).toBe("mrr:money*,stage:select,seats:number,champion:relation→contact");
    expect(account.stages).toEqual(["trial", "customer", "churned"]);
    // What the section costs every brief of a business workspace.
    expect(JSON.stringify(brief.business).length).toBeLessThan(400);
  });

  it("reads the metrics summary through data(op=metrics)", async () => {
    await ok("admin_write", { op: "set_business", business_model: "b2b" });
    const month = new Date().toISOString().slice(0, 7);
    await insertEvents(storage, [
      { type: "subscription.started", occurred_at: `${month}-01T09:00:00Z`, idempotency_key: "s1", subject_id: "acc_1", amount: 490, currency: "EUR" },
      { type: "subscription.started", occurred_at: `${month}-01T10:00:00Z`, idempotency_key: "s2", subject_id: "acc_2", amount: 10, currency: "EUR" },
    ], null);
    await runBusinessRollup(workspaceId);
    const summary = await ok<{ kpi_set: string; kpis: Array<{ key: string; current: number | null }> }>("data", { op: "metrics" });
    expect(summary.kpi_set).toBe("saas");
    expect(summary.kpis.find((k) => k.key === "mrr")?.current).toBe(500);
    expect(summary.kpis.find((k) => k.key === "active_customers")?.current).toBe(2);
  });

  it("keeps people in a dataset, upserts them by key, promotes one and erases another", async () => {
    const dataset = await ok<{ id: string }>("data_write", {
      op: "create", title: "Clients", description: "Ski clients", rows: [{ external_id: "seed", zone: "Baqueira" }],
    });
    await ok("admin_write", {
      op: "record_type",
      key: "client",
      definition: {
        label: "Client", storage: "dataset", dataset_node_id: dataset.id,
        fields: [{ key: "name", label: "Name", type: "text" }, { key: "zone", label: "Zone", type: "text" }, { key: "lessons", label: "Lessons", type: "number" }],
      },
    });
    await ok("admin_write", {
      op: "record_type",
      key: "vip",
      definition: { label: "VIP client", fields: [{ key: "zone", label: "Zone", type: "text" }, { key: "lessons", label: "Lessons", type: "number" }] },
    });
    const type = (await getRecordType(storage, "client"))!;

    const first = await upsertDatasetRecords(storage, type, [
      { external_id: "cli_1", fields: { name: "Ana", zone: "Baqueira", lessons: 3 } },
      { external_id: "cli_2", fields: { name: "Ben", zone: "Formigal", lessons: 1 } },
      { external_id: "cli_3", fields: { lessons: "many" } },
    ]);
    expect(first.map((r) => r.status)).toEqual(["created", "created", "invalid"]);
    const again = await upsertDatasetRecords(storage, type, [{ external_id: "cli_1", fields: { lessons: 4 } }]);
    expect(again[0]!.status).toBe("updated");
    const ana = stored.get(dataset.id)!.find((r) => r.key === "cli_1")!;
    expect(ana.data).toMatchObject({ external_id: "cli_1", name: "Ana", zone: "Baqueira", lessons: 4 });

    // The same through MCP, by key column.
    await ok("data_write", { op: "upsert_rows", node_id: dataset.id, key_column: "external_id", rows: [{ external_id: "cli_2", lessons: 2 }] });
    expect(stored.get(dataset.id)!.find((r) => r.key === "cli_2")!.data.lessons).toBe(2);

    const promoted = await ok<{ id: string; created: boolean; node: { title: string; data: Record<string, unknown> } }>("data_write", {
      op: "promote_row", node_id: dataset.id, key: "cli_1", record_type: "vip",
    });
    expect(promoted.created).toBe(true);
    expect(promoted.node.title).toBe("Ana");
    expect(promoted.node.data).toMatchObject({ fields: { zone: "Baqueira", lessons: 4 }, source_row: { dataset_node_id: dataset.id, key: "cli_1" } });
    const repromoted = await ok<{ id: string; created: boolean }>("data_write", { op: "promote_row", node_id: dataset.id, key: "cli_1", record_type: "vip" });
    expect(repromoted).toMatchObject({ id: promoted.id, created: false });

    const dsKind = await call("nodes_write", { op: "create", kind: "client", title: "Not a node" });
    expect(text(dsKind)).toContain("live in a dataset");

    await insertEvents(storage, [
      { type: "booking.created", occurred_at: "2026-01-10T10:00:00Z", idempotency_key: "b1", subject_id: "cli_2", amount: 100, currency: "EUR", properties: { booking_id: "b1", supplier_id: "ins_1" } },
    ], null);
    const erased = await eraseRecord(storage, type, "cli_2");
    expect(erased).toEqual({ external_id: "cli_2", record_removed: true, events_unlinked: 1 });
    expect(stored.get(dataset.id)!.some((r) => r.key === "cli_2")).toBe(false);
    const [event] = await loadRollupEvents(storage);
    expect(event!.subject_id).toMatch(/^erased:/);
  });

  it("refuses to delete a record type that still has nodes", async () => {
    await ok("nodes_write", { op: "create", kind: "contact", title: "Iker" });
    const res = await call("admin_write", { op: "delete_record_type", key: "contact" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("still has nodes");
  });
});
