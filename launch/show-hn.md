# Show HN

Post at <https://news.ycombinator.com/submit> with the repository URL as the
link. Post the first comment yourself right after submitting. Do not ask
anyone to upvote, and do not share the HN link asking for votes (HN
penalises it and it breaks the guidelines).

## Title (78 characters)

```text
Show HN: Bcontext – self-hosted shared memory for teams of AI agents, over MCP
```

Alternative if the first reads too long:
`Show HN: Bcontext – a shared workspace your team's coding agents read and write`

## First comment

```text
Hi HN, I'm the maintainer of Bcontext.

The problem: my team worked with several agents (Claude Code, Cursor,
Codex) on different machines, and every session started from zero. What
one agent decided on Monday lived in a chat nobody reopened, so the next
agent, run by someone else with another model, contradicted it or redid
the work. Each tool's memory is per person and per tool.

Bcontext is a workspace that all of them, and the people, read and write
over MCP. It is a typed graph (tasks, decisions, ADRs, docs, meetings,
bugs) and the loop it teaches agents is small:

  - start with brief(): what is unblocked, which decisions are open, what
    changed since this token last looked
  - mark a task in_progress, do the work, write decisions down as nodes
  - close it by appending a "## Result" section; the next agent reads that
    instead of a transcript

Some details that turned out to matter:

  - Every "##" heading is an addressable block (/n/<id>#result), and
    agents append or replace one block at a time, so two agents editing the
    same node rarely collide. Whole-body edits need if_updated_at; a 409
    means re-read and merge.
  - One MCP endpoint per workspace, OAuth 2.1 or scoped agent tokens, and
    tools/list only shows what the caller may do.
  - Search is hybrid (pgvector + keyword) with one-hop graph expansion, and
    ask_rag cites the nodes it used. With no AI key it falls back to
    keyword search; it works with an OpenAI-compatible server too.
  - Every write records who made it, person or agent, in an append-only
    audit log with a hash chain, and there is a change feed agents use to
    re-sync.

It is self-hosted: ./setup.sh then docker compose up -d (Postgres +
pgvector, Supabase Auth/Storage, a Hono API, a Next.js app, Caddy). AGPL-3.0.

Honest limitations:
  - It started as a commercial product and is now open source, maintained
    by one person on a best-effort basis.
  - The stack is heavier than a single binary; it wants ~4 GB of RAM to
    build from source (pre-built images are on GHCR).
  - Semantic search needs a 1536-dimensional embedding model; many local
    embedding models are not, so with those you stay on keyword search.
  - It is aimed at teams; for one person and one tool, the tool's own
    memory may be enough.

What I'd like feedback on: whether the brief/Result loop matches how you
hand work between agents, and what stops you from trying it (setup, the
stack, the license).

Repo: https://github.com/Ibonarambarri/Bcontext
```

Before posting, check the claims still hold on `main` (build RAM, images on
GHCR, the tool names), and replace the opening story with your own words if
it differs from what happened. [TODO: your story]
