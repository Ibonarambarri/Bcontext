// The agent working loop with the official MCP TypeScript SDK: brief →
// create a task → close it with a `## Result`. The same calls Claude Code or
// Cursor make for you, for when you build your own agent or automation.
//
//   npm install
//   BCONTEXT_URL=http://localhost:8080 BCONTEXT_WORKSPACE=demo \
//   BCONTEXT_TOKEN=bctx_live_… node agent-loop.mjs
//
// The token needs nodes:read and nodes:write (Agents → Add agent → API key).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { BCONTEXT_URL, BCONTEXT_WORKSPACE, BCONTEXT_TOKEN } = process.env;
if (!BCONTEXT_URL || !BCONTEXT_WORKSPACE || !BCONTEXT_TOKEN) {
  console.error("set BCONTEXT_URL, BCONTEXT_WORKSPACE and BCONTEXT_TOKEN");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(
  new URL(`/mcp/${BCONTEXT_WORKSPACE}`, BCONTEXT_URL),
  { requestInit: { headers: { Authorization: `Bearer ${BCONTEXT_TOKEN}` } } },
);
const client = new Client({ name: "bcontext-example", version: "1.0.0" });
await client.connect(transport);

// Every Bcontext tool answers with one JSON text block.
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

const brief = await call("brief", { top: 3 });
console.log(`brief: ${brief.counts.nodes} nodes, ${brief.unblocked.total} unblocked tasks`);

const task = await call("nodes_write", {
  op: "create",
  kind: "task",
  status: "in_progress",
  title: "Try the Bcontext agent loop from the MCP SDK",
  content_md: "## Goal\nCheck that a custom agent can pick up, work and close a task.",
});
console.log(`created task ${task.id}`);

await call("nodes_write", {
  op: "append",
  node_id: task.id,
  heading: "Result",
  body_md: "Ran examples/node/agent-loop.mjs against the instance; the loop works.",
});
await call("nodes_write", { op: "update", id: task.id, patch: { status: "done" } });

const { node: done } = await call("nodes", { op: "get", id: task.id, include_content: true });
console.log(`\n${done.title} [${done.status}]\n${done.content_md}`);

await client.close();
