# Examples

Small, runnable examples against a Bcontext instance. The scripts and the
Claude Code configuration were run against a local stack started with the
[Quickstart](../README.md#quickstart); the Cursor and Codex files follow
[docs/connect-agents.md](../docs/connect-agents.md).

| Example | What it shows | Needs |
|---|---|---|
| [`curl/agent-loop.sh`](curl/agent-loop.sh) | The agent loop over raw MCP-over-HTTP: `brief` → create a task → close it with a `## Result` | `curl`, `jq` |
| [`node/agent-loop.mjs`](node/agent-loop.mjs) | The same loop with the official MCP TypeScript SDK, for your own agents and automations | Node 18+ |
| [`curl/import-skill.sh`](curl/import-skill.sh) | Import a `SKILL.md` so every connected agent can fetch and follow it | `curl`, `jq` |
| [`skills/release-notes/SKILL.md`](skills/release-notes/SKILL.md) | A skill that drafts release notes from the `## Result` of closed tasks | — |
| [`mcp-clients/`](mcp-clients) | Client configuration for Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`) and Codex | the client |

## Setup

1. Start Bcontext and create your account and workspace (see the
   [Quickstart](../README.md#quickstart)). With `make up` the instance is at
   `http://localhost:8080`.
2. In the web app, **Agents → Add agent → API key**, with the writer scopes
   (`nodes:read`, `nodes:write`). Copy the `bctx_live_…` token: it is shown
   once.
3. Export the three variables the examples read:

   ```bash
   export BCONTEXT_URL=http://localhost:8080   # your instance, no trailing /mcp
   export BCONTEXT_WORKSPACE=demo              # the slug in /w/<slug>
   export BCONTEXT_TOKEN=bctx_live_…
   ```

## Run them

```bash
./examples/curl/agent-loop.sh
./examples/curl/import-skill.sh examples/skills/release-notes/SKILL.md

cd examples/node && npm install && npm start
```

`agent-loop` prints something like:

```text
▸ brief
{"nodes":0,"unblocked":0,"open_decisions":0,"changes":0}
▸ create a task
  task 7db3531a-00c0-444e-8c3d-f6fd345e2a38
▸ close it with a ## Result
▸ read it back
  Try the Bcontext agent loop from curl [done]
## Goal
Check that an agent can pick up, work and close a task over MCP.

## Result

Ran examples/curl/agent-loop.sh: brief, create, append and status all work over plain HTTP.
```

Open the workspace in the web app afterwards: the task is on the board and
the **Changes** view shows the writes as made by the agent token.

## Client configuration

The files in [`mcp-clients/`](mcp-clients) point at
`http://localhost:8080/mcp/demo` and read the token from
`BCONTEXT_MCP_TOKEN`. Change the URL to your instance and workspace.

- **Claude Code**: copy `claude-code.mcp.json` to `.mcp.json` at the root of
  your project, `export BCONTEXT_MCP_TOKEN=bctx_live_…`, restart Claude Code
  and approve the server. Drop the `headers` entry to use OAuth instead.
- **Cursor**: copy `cursor.mcp.json` to `.cursor/mcp.json`.
- **Codex**: run `mcp-clients/codex.sh`.

[docs/connect-agents.md](../docs/connect-agents.md) covers every client and
the token scopes.
