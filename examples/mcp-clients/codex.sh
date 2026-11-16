#!/usr/bin/env bash
# Register a Bcontext workspace with the Codex CLI.
# OAuth (Codex opens the browser):
#   codex mcp add bcontext --url http://localhost:8080/mcp/demo
# Agent token, read from an environment variable:
set -euo pipefail
: "${BCONTEXT_MCP_TOKEN:?export BCONTEXT_MCP_TOKEN=bctx_live_… first}"
codex mcp add bcontext --url "${BCONTEXT_URL:-http://localhost:8080}/mcp/${BCONTEXT_WORKSPACE:-demo}" \
  --bearer-token-env-var BCONTEXT_MCP_TOKEN
