/**
 * Business templates and record views over MCP on the demo backend: an admin
 * applies the b2b template with `admin_write(op=apply_business_template)`
 * (twice — the second run creates nothing), an agent writes a deal, and
 * `views(op=resolve)` returns the records with their fields, as the web
 * receives them; `views(op=query)` refuses a field the type does not have.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { _resetDemoBusiness } from "@/lib/business/record-types";
import { _resetDemoEvents } from "@/lib/business/events";
import { resetDemoViewsForTests } from "@/lib/views/store";
import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) => (result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";

describe("business views over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;

  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  async function ok<T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await call(name, args);
    expect(res.isError, text(res)).toBeFalsy();
    return JSON.parse(text(res)) as T;
  }

  beforeEach(async () => {
    _resetDemoBusiness();
    _resetDemoEvents();
    resetDemoViewsForTests();
    const slug = `mcp-bizviews-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Agency", slug });
    const storage = resolveDemoStorage(slug)!;
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
  });

  afterEach(async () => close());

  it("applies the b2b template idempotently and resolves the pipeline with fields", async () => {
    const first = await ok("admin_write", { op: "apply_business_template", business_model: "b2b" });
    expect(first.created.record_types).toEqual(["account", "contact", "deal", "request"]);
    expect(first.created.views).toHaveLength(6);
    const second = await ok("admin_write", { op: "apply_business_template", business_model: "b2b" });
    expect(second.created).toEqual({ record_types: [], datasets: [], views: [] });

    await ok("nodes_write", { op: "create", title: "Acme renewal", kind: "deal", fields: { stage: "proposal", amount: { amount: 2100, currency: "EUR" } } });
    const pipeline = first.created.views.find((view: { key: string }) => view.key === "pipeline");
    const resolved = await ok("views", { op: "resolve", id: pipeline.id });
    expect(resolved.records.rows).toEqual([expect.objectContaining({ title: "Acme renewal", fields: { stage: "proposal", amount: { amount: 2100, currency: "EUR" } } })]);

    const refused = await call("views", { op: "query", query: { schema_version: 1, kinds: ["deal"], field_filters: [{ field: "mrr", op: "gt", value: 0 }] } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/`mrr` is not a field of deal/);
  });
});
