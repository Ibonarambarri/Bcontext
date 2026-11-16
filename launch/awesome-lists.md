# Awesome lists

Submit after launch day, once the README has the demo GIF and a current
GitHub Release, and one list at a time. **Every list's rules below are from
memory and may be out of date — read its CONTRIBUTING file and recent
merged PRs before submitting.** Match the list's exact entry format, keep
alphabetical order where the list uses it, and never open the same PR
twice.

Shared PR body (adapt per list):

```text
Adds Bcontext, a self-hosted MCP server and web app that gives a team's AI
agents one shared memory: a typed graph of tasks, decisions and docs that
Claude Code, Cursor, Codex and people read and write, with scoped tokens
and an audit trail. TypeScript, AGPL-3.0, actively maintained.

I'm the author. I've read the contribution guidelines and placed the entry
in <section> following the list's format.
```

---

## punkpeye/awesome-mcp-servers

- URL: <https://github.com/punkpeye/awesome-mcp-servers>
- Section: **Knowledge & Memory**.
- Rules to verify: entries use legend emojis for language and scope
  (📇 TypeScript, 🏠 local/self-hosted, ☁️ cloud, OS icons). The list has
  at times asked that servers also be listed on Glama — check whether that
  is still required.
- Entry:

```markdown
- [Ibonarambarri/Bcontext](https://github.com/Ibonarambarri/Bcontext) 📇 🏠 - Self-hosted shared memory for teams of AI agents: tasks, decisions and docs as a typed graph, per-workspace endpoints with OAuth 2.1 or scoped tokens, hybrid search with citations and an audit trail.
```

## appcypher/awesome-mcp-servers

- URL: <https://github.com/appcypher/awesome-mcp-servers>
- Section: **Knowledge & Memory** (verify the current name).
- Rules to verify: entry format with an icon/logo column; check recent PRs.
- Entry: same one-line description as above, in that list's format.

## wong2/awesome-mcp-servers

- URL: <https://github.com/wong2/awesome-mcp-servers>
- **Verify before submitting:** this list has redirected submissions to a
  form on its companion site (mcpservers.org) instead of pull requests. If
  so, use the form with the same description.

## awesome-selfhosted

- URL: <https://github.com/awesome-selfhosted/awesome-selfhosted>
- **Not yet eligible, verify:** the list requires the project to have been
  first released more than 4 months before submission. The first GitHub
  Release (`v0.1.0`) is dated 2026-10-15, so the earliest date is around
  mid-February 2027.
- **Submissions go to the data repository**, not the README:
  <https://github.com/awesome-selfhosted/awesome-selfhosted-data> — one
  YAML file per project under `software/`. Verify the schema there.
- Section (tag): **Knowledge Management Tools** or **Software Development -
  Project Management**; pick the one whose existing entries look most like
  Bcontext.
- Description rules to verify: short, ends with a period, does not repeat
  "self-hosted", "open-source" or "free".
- Draft fields:

```yaml
name: Bcontext
website_url: https://github.com/Ibonarambarri/Bcontext
source_code_url: https://github.com/Ibonarambarri/Bcontext
description: Shared memory for teams working with AI agents - tasks, decisions and docs that agents read and write over MCP.
licenses:
  - AGPL-3.0
platforms:
  - Docker
  - Nodejs
tags:
  - Knowledge Management Tools
```

## hesreallyhim/awesome-claude-code

- URL: <https://github.com/hesreallyhim/awesome-claude-code>
- **Verify before submitting:** this list has taken submissions through an
  issue form ("recommend a resource") rather than pull requests.
- Category: tooling / MCP or plugins (pick the closest current one). The
  repository is also a Claude Code plugin marketplace (`plugin/`,
  `.claude-plugin/marketplace.json`), which fits a plugins category.
- Description:

```text
Bcontext — a self-hosted shared memory for teams using Claude Code: a plugin
(conventions skill + /bcontext:brief) and an MCP server where agents start
from a brief and hand off work with a "## Result".
```

## e2b-dev/awesome-ai-agents

- URL: <https://github.com/e2b-dev/awesome-ai-agents>
- **Verify before submitting:** this list catalogues agents and has used a
  submission form plus a detailed entry format. Bcontext is infrastructure
  for agents rather than an agent, so read the scope first and skip it if it
  does not fit.

## The MCP Registry

- <https://github.com/modelcontextprotocol/registry>
- The official `modelcontextprotocol/servers` README stopped accepting
  community server entries in favour of this registry (verify). The
  registry describes installable packages or public remote URLs; a
  self-hosted server with a per-instance URL may not fit its model yet.
  Read its docs before spending time here.
