---
title: "Giving a team's AI agents one shared memory, over MCP"
published: false
tags: ai, mcp, opensource, selfhosted
cover_image: # TODO: upload docs/images/node.png or the social preview
---

<!--
Draft for dev.to (front matter above) or Hashnode (drop the front matter,
set the same title and tags there). Replace every [TODO: …] with your own
words; do not invent anecdotes or numbers.
-->

## The problem

[TODO: your story — when you noticed agents on your team redoing or
contradicting each other's work. One concrete example beats a general
claim.]

The pattern behind it is general. Every coding agent session starts from
zero. Whatever memory a tool has belongs to one person and one tool: what
my Claude Code learned is not what my teammate's Cursor knows. A decision
made on Monday lives in a chat transcript nobody will reopen. The next
agent, on another machine with another model, contradicts it or does the
work again.

Transcripts are the wrong thing to share anyway. They are long, they mix
dead ends with conclusions, and nobody, human or agent, reads them twice.
What the next agent needs is the state of the work: what is open, what was
decided, and what the last person who touched it left behind.

## What I built

Bcontext is a self-hosted workspace that agents and people share. Agents
connect over MCP (Claude Code, Cursor, Codex, anything that speaks
Streamable HTTP); people use a web app over the same data.

### A typed graph, not a pile of notes

Everything is a node with a kind: task, decision, ADR, doc, meeting, bug,
entity, dataset, goal. Nodes have a status lifecycle, subtasks, tags and
typed links (`blocked_by`, `supersedes`, `references`…). Typed links are
what let an agent ask "what can I start now?" —
`nodes({ op: "list", kind: "task", unblocked: true })` — instead of
parsing prose like "depends on the auth work".

### A loop small enough that agents follow it

The server's `instructions`, sent on `initialize`, teach one loop:

1. **`brief()`** first: counts, the unblocked queue by priority, open
   decisions, what is assigned to you and what changed since this token's
   previous brief.
2. Take a task and mark it `in_progress`, so others see who is on it.
3. Write as you go: decisions and findings are nodes.
4. Close with a **`## Result`** section — what was done, where, what is
   left — and set the task `done`.

That `## Result` is the handoff. The next agent reads three paragraphs
instead of a transcript.

### Blocks, so agents do not clobber each other

Every `##` heading in a node is an addressable block (`/n/<id>#result`).
Agents append a block or replace one block, and two agents writing
different sections of the same node do not conflict. Edits to the whole
body must carry `if_updated_at` from the agent's last read; if someone
wrote first, the server answers 409 and the agent re-reads, merges and
retries — optimistic concurrency, the same idea as an ETag.

### Re-syncing without re-reading everything

Long sessions drift. Instead of re-reading the tree, an agent calls
`list_changes({ since })`: a workspace-scoped change feed with who changed
what, person or agent.

### Retrieval that cites

Search is hybrid: pgvector similarity plus keyword search, with one-hop
expansion along the graph's links. `ask_rag` answers with citations to the
nodes it used, so an agent (or a person) can check the source. With no AI
key configured it degrades to keyword search rather than failing; with an
OpenAI-compatible server (Ollama, LiteLLM, vLLM) or the Vercel AI Gateway
it gets embeddings and written answers.

### Who wrote what

Each workspace has members, roles and per-principal grants; agents use
OAuth 2.1 or scoped tokens, and `tools/list` only shows what the caller is
allowed to do. Every write records its author, person or agent, in an
append-only audit log with a hash chain.

### How it runs

One `docker compose` project: Caddy in front (automatic HTTPS), a Next.js
web app with no data of its own, a Hono API that serves REST and the MCP
server, a pg-boss worker, Postgres 15 with pgvector, and Supabase Auth and
Storage. `./setup.sh` writes the secrets; `docker compose up -d` starts it.

```bash
git clone https://github.com/Ibonarambarri/bcontext.git && cd bcontext
./setup.sh --domain localhost --admin-email you@example.com -y
docker compose up -d
```

The repository's `examples/` folder has the whole agent loop as a curl
script and as a Node script on the MCP SDK.

## What I learned

[TODO: rewrite these in your own words; keep only the ones that are true
for you.]

- **Agents follow conventions they are told at connect time.** The MCP
  `instructions` field is the manual; keeping it short and accurate mattered
  more than adding tools.
- **Write granularity decides whether concurrency hurts.** Section-level
  writes let agents work on the same node without stepping on each other;
  the 409 path is for whole-body edits.
- **The handoff is a summary, not a log.** Asking agents to close with a
  `## Result` was the single convention that made the next session better.
- **Filter the tool list per caller.** An agent that cannot see a tool does
  not try to call it.
- [TODO: what you would do differently.]

## Status and limitations

It started as a commercial product and is now open source (AGPL-3.0),
maintained by me on a best-effort basis. The stack is heavier than a single
binary; building from source wants about 4 GB of RAM (pre-built images are
on GHCR). Semantic search needs 1536-dimensional embeddings, which rules
out several popular local embedding models for now.

Issues and pull requests are welcome; some are labelled `good first issue`.

Repo: <https://github.com/Ibonarambarri/Bcontext>
