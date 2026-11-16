# GitHub repository settings

Set these under the repository's **About** (gear icon) and **Settings →
General**. Nothing here changes code.

## Description

```text
Self-hosted shared memory for teams of AI agents. Claude Code, Cursor, Codex and your teammates read and write the same tasks, decisions and docs over MCP: a brief to start from, a ## Result to hand off, scoped tokens and an audit trail of who wrote what. AGPL-3.0, one docker compose up.
```

288 characters (limit 350). The current description is fine too; this one
adds what makes it different (the brief/Result loop, scopes, audit).

## Topics (12)

```text
mcp  model-context-protocol  mcp-server  ai-agents  agent-memory
claude-code  cursor  knowledge-graph  self-hosted  pgvector  typescript  llm
```

Changes from today's set: keep `mcp`, `model-context-protocol`, `ai-agents`,
`claude-code`, `knowledge-graph`, `self-hosted`; add `mcp-server`,
`agent-memory`, `cursor`, `pgvector`, `typescript`, `llm`; drop `nextjs` and
`supabase` (implementation details people do not search for when looking for
this kind of tool; they stay in the README's stack line).

## Homepage

There is no public site or demo instance. Until there is, point the
homepage at the quickstart so the link is not empty:
`https://github.com/Ibonarambarri/Bcontext#quickstart`. Do not link a
demo instance unless it is running and safe to expose (sign-up off,
`--workspace-creation admin`).

## Social preview

Settings → General → Social preview, 1280×640 PNG. Suggested layout:
logo (`docs/images/logo-light.svg`) and the tagline "The shared memory your
AI agents read and write" on the left; a crop of `docs/images/graph.png` or
`docs/images/node.png` (the `## Result` section visible) on the right. Keep
text large enough to read at 600 px wide.

## Other settings

- **Releases**: tags `v0.2.0` … `v0.4.3` exist but only `v0.1.0` has a
  GitHub Release. Create the missing ones from the tags (generate notes from
  the merged PRs); visitors read "last release" as "is this alive".
- **Private vulnerability reporting**: Settings → Code security → enable.
  `CONTRIBUTING.md` already tells people to use it; today it is off.
- **Discussions**: enable, with a Q&A category, so usage questions do not
  land as issues.
- **Labels**: make sure `good first issue` and `help wanted` exist (GitHub
  creates them by default).
