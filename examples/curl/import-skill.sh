#!/usr/bin/env bash
# Import a SKILL.md into a workspace, so every agent connected to it can
# fetch it with skills({ op: "get" }) and follow it with its own model.
#
#   BCONTEXT_URL=http://localhost:8080 BCONTEXT_WORKSPACE=demo \
#   BCONTEXT_TOKEN=bctx_live_… ./import-skill.sh ../skills/release-notes/SKILL.md
#
# Importing again with a changed body bumps the skill's version; the same
# body is a no-op. The token needs nodes:write.
set -euo pipefail

: "${BCONTEXT_URL:?set BCONTEXT_URL, e.g. http://localhost:8080}"
: "${BCONTEXT_WORKSPACE:?set BCONTEXT_WORKSPACE to the workspace slug}"
: "${BCONTEXT_TOKEN:?set BCONTEXT_TOKEN to an agent token (bctx_live_…)}"
SKILL_FILE="${1:?usage: $0 path/to/SKILL.md}"
command -v jq >/dev/null || { echo "this example needs jq" >&2; exit 1; }
# The skill is keyed by the `name:` in its frontmatter.
NAME=$(sed -n 's/^name:[[:space:]]*//p' "$SKILL_FILE" | head -n 1)
[ -n "$NAME" ] || { echo "$SKILL_FILE has no name: in its frontmatter" >&2; exit 1; }

curl -fsS -X POST "$BCONTEXT_URL/mcp/$BCONTEXT_WORKSPACE" \
  -H "Authorization: Bearer $BCONTEXT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -n --arg name "$NAME" --rawfile body "$SKILL_FILE" \
    '{jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {name: "skills_write", arguments: {op: "import", name: $name, body_md: $body}}}')" |
  jq -er 'if .error then error(.error.message)
         elif .result.isError then error(.result.content[0].text)
         else .result.content[0].text | fromjson end'
