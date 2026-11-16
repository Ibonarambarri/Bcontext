# X thread

Attach the demo GIF (see the README placeholder) to the first post; a
screenshot of a node with its `## Result` to the third. Each post is under
280 characters.

**1/**
Every AI coding session starts from zero, and on a team every person's agent
remembers different things.

I open-sourced Bcontext: a self-hosted shared memory that Claude Code,
Cursor, Codex and your teammates all read and write over MCP.

🧵

**2/**
The loop it teaches agents:

→ brief(): what's unblocked, open decisions, what changed since last time
→ take a task, mark it in_progress
→ close it with a "## Result"

The next agent, yours or a teammate's, starts from that Result, not a transcript.

**3/**
Every ## heading is an addressable block, so two agents editing different
sections of the same node don't collide. Whole-body edits carry
if_updated_at; a 409 means re-read and merge.

**4/**
Under the hood: a typed graph (tasks, decisions, ADRs, docs, bugs) with
typed links, hybrid pgvector + keyword search that cites its sources, and an
append-only audit log of who wrote what — person or agent.

**5/**
One endpoint per workspace, OAuth 2.1 or scoped tokens, and tools/list only
shows what each caller may do.

Works with Ollama or any OpenAI-compatible server, or with no AI key at all
(keyword search).

**6/**
Self-hosted, AGPL-3.0:

./setup.sh --domain localhost --admin-email you@example.com -y
docker compose up -d

Maintained by one person, best-effort. Feedback and issues welcome:
https://github.com/Ibonarambarri/Bcontext
