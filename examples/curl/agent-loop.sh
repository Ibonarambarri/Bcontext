#!/usr/bin/env bash
# The agent working loop over plain MCP-over-HTTP, with nothing but curl and
# jq: brief → create a task → work → close it with a `## Result` → brief.
#
# This is what an MCP client (Claude Code, Cursor, Codex) does for you; here
# it is spelled out so you can see the wire format and script against it.
#
#   BCONTEXT_URL=http://localhost:8080 BCONTEXT_WORKSPACE=demo \
#   BCONTEXT_TOKEN=bctx_live_… ./agent-loop.sh
#
# The token needs nodes:read and nodes:write (Agents → Add agent → API key).
set -euo pipefail

: "${BCONTEXT_URL:?set BCONTEXT_URL, e.g. http://localhost:8080}"
: "${BCONTEXT_WORKSPACE:?set BCONTEXT_WORKSPACE to the workspace slug}"
: "${BCONTEXT_TOKEN:?set BCONTEXT_TOKEN to an agent token (bctx_live_…)}"
command -v jq >/dev/null || { echo "this example needs jq" >&2; exit 1; }

ENDPOINT="$BCONTEXT_URL/mcp/$BCONTEXT_WORKSPACE"
ID=0

# call <tool> <json-args>: one MCP tools/call, prints the tool's text result.
call() {
  ID=$((ID + 1))
  curl -fsS -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $BCONTEXT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$(jq -n --arg tool "$1" --argjson args "$2" --argjson id "$ID" \
      '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: $tool, arguments: $args}}')" |
    jq -er 'if .error then error(.error.message) elif .result.isError then error(.result.content[0].text) else .result.content[0].text end'
}

echo "▸ brief"
call brief '{"top": 3}' | jq -c '{nodes: .counts.nodes, unblocked: .unblocked.total, open_decisions: .open_decisions.total, changes: (.changes.entries | length)}'

echo "▸ create a task"
TASK=$(call nodes_write '{
  "op": "create", "kind": "task", "status": "in_progress", "priority": "med",
  "title": "Try the Bcontext agent loop from curl",
  "content_md": "## Goal\nCheck that an agent can pick up, work and close a task over MCP."
}')
TASK_ID=$(jq -r '.id // .node.id' <<<"$TASK")
echo "  task $TASK_ID"

echo "▸ close it with a ## Result"
call nodes_write "$(jq -n --arg id "$TASK_ID" '{
  op: "append", node_id: $id, heading: "Result",
  body_md: "Ran examples/curl/agent-loop.sh: brief, create, append and status all work over plain HTTP."
}')" >/dev/null
call nodes_write "$(jq -n --arg id "$TASK_ID" '{op: "update", id: $id, patch: {status: "done"}}')" >/dev/null

echo "▸ read it back"
call nodes "$(jq -n --arg id "$TASK_ID" '{op: "get", id: $id, include_content: true}')" |
  jq -r '(.node // .) | "  \(.title) [\(.status)]\n\(.content_md)"'
