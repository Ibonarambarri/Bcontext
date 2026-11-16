# Reddit

One post per subreddit, spaced over several days, each written for that
community. Rules change often: **read each subreddit's sidebar and pinned
posts on the day you post** — the notes below are what to look for, not a
guarantee of the current rules.

General Reddit norm: most of your activity should not be self-promotion
(the old "9:1" guideline). Post from your normal account, disclose that you
are the author, answer comments, and never ask for upvotes.

---

## r/selfhosted

**Check current rules:** r/selfhosted has had dedicated days or threads
for new-project announcements and requires disclosing that you are the
developer. Look for the current self-promotion rule and any required flair
before posting.

**Title:** `Bcontext: self-hosted shared memory for your team's AI agents (MCP, docker compose, AGPL)`

**Body:**

```text
I'm the developer. Bcontext is a workspace (tasks, decisions, docs,
meetings) that coding agents like Claude Code, Cursor and Codex read and
write over MCP, and that people review in a web app.

Self-hosting details, since that's what this sub cares about:
- ./setup.sh writes .env with fresh secrets, then docker compose up -d
- Caddy is the only service with published ports and gets HTTPS for a
  real domain automatically; it also runs behind an existing reverse proxy
- Postgres 15 + pgvector, Supabase Auth/Storage (files on a volume),
  pg-boss worker. Pre-built amd64/arm64 images on GHCR, or build from source
- AI is optional: without a key, search is keyword-only; it works with any
  OpenAI-compatible server (Ollama, LiteLLM, vLLM) or the Vercel AI Gateway
- Backups and updates are documented in docs/self-hosting.md

Limitations: it's a multi-container stack, not a single binary; building
from source wants ~4 GB RAM; maintained by one person, best-effort.

https://github.com/Ibonarambarri/Bcontext
```

---

## r/ClaudeAI

**Check current rules:** look for required post flair (there is usually
one for projects built with or for Claude) and any limits on promotional
posts.

**Title:** `I built a shared memory for teams using Claude Code: agents start from a brief and hand off with a ## Result`

**Body:**

```text
Each Claude Code session starts from zero, and on a team each person's
sessions remember different things. Bcontext is a self-hosted MCP server +
web app that the whole team's agents share.

The loop the plugin teaches Claude:
1. brief() — unblocked tasks, open decisions, what changed since last time
2. take a task, mark it in_progress, write decisions as nodes
3. append "## Result" and set it done; the next session (yours or a
   teammate's) reads that instead of the transcript

Install the plugin:
  /plugin marketplace add Ibonarambarri/bcontext
  /plugin install bcontext@bcontext
or `claude mcp add --transport http bcontext https://your-host/mcp/<workspace>`
(OAuth opens the browser).

It also works with Cursor, Codex and other MCP clients. Self-hosted,
AGPL-3.0, I'm the author. https://github.com/Ibonarambarri/Bcontext
```

---

## r/mcp

**Check current rules:** usually welcomes server announcements; check for
a showcase flair.

**Title:** `Bcontext: a multi-tenant MCP server for team memory (per-workspace endpoints, OAuth 2.1, filtered tools/list)`

**Body:**

```text
Author here. Some MCP-specific design choices in case they're useful to
other server authors:

- Streamable HTTP, stateless, one endpoint per workspace (/mcp/<slug>)
  plus a root /mcp that takes the workspace from the token
- OAuth 2.1 with discovery and dynamic registration, or scoped bearer
  tokens; tools/list is filtered to what the caller may do
- The server's `instructions` on initialize are the agent's manual
  (conventions: start with brief, write by ## block, if_updated_at on
  whole-body edits, close with ## Result)
- Writes take optimistic concurrency (409 on a stale if_updated_at) and
  there's a change feed (list_changes) for cheap re-sync
- It can also proxy other MCP servers behind capability_search /
  capability_call, granted per agent

Repo (AGPL-3.0, self-hosted): https://github.com/Ibonarambarri/Bcontext
Feedback on the tool surface is very welcome.
```

---

## r/LocalLLaMA

**Check current rules:** posts must be about local models; promotional
posts are limited. Lead with the local-model angle and be upfront about
the embedding constraint.

**Title:** `Shared agent memory you can run fully local: Bcontext + Ollama (with one caveat about embeddings)`

**Body:**

```text
I'm the author of Bcontext, a self-hosted workspace that coding agents
read and write over MCP. Its AI features (embeddings, the cited ask_rag
answers, meeting extraction) run against any OpenAI-compatible server, so
you can point it at Ollama, LiteLLM or vLLM:

  OPENAI_BASE_URL=http://host.docker.internal:11434/v1

The caveat: the vector columns are 1536-dimensional. nomic-embed-text
(768) and mxbai-embed-large (1024) don't fit, and with them embedding
writes fail. Without embeddings it still works on keyword search. If
anyone has a good local 1536-d embedding model, I'd like to hear it — or
whether configurable dimensions should be a priority.

https://github.com/Ibonarambarri/Bcontext (AGPL-3.0)
```

---

## r/opensource

**Check current rules:** usually requires a flair for promotional posts
and a substantive description, not just a link.

**Title:** `Bcontext is now open source (AGPL-3.0): shared memory for teams of AI agents`

**Body:**

```text
Bcontext started as a commercial product; I've released it as open
source so anyone can run it. It's a typed knowledge graph (tasks,
decisions, docs) that AI agents and people share over MCP, with an audit
trail of who wrote what.

Why AGPL: [TODO: your reasoning in one or two sentences].

It's maintained by one person on a best-effort basis. Contributions are
welcome: there are issues labelled "good first issue", and CONTRIBUTING.md
and AGENTS.md describe the rules.

https://github.com/Ibonarambarri/Bcontext
```
