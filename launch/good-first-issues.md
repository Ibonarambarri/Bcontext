# Good first issues

Each of these was checked against the code on `docs/open-source-polish`
(the files are listed under each). Open them with the `good first issue`
label plus the area label shown; paste the body as written.

---

## 1. Run shellcheck on the shell scripts in CI

Labels: `good first issue`, `ci`

**Context.** CI only checks shell syntax: `.github/workflows/ci.yml` runs
`sh -n deploy/migrate/migrate.sh && bash -n setup.sh`. `setup.sh` writes
every secret of an instance, so lint-level mistakes there (unquoted
variables, unchecked `cd`) matter. The `examples` job already runs
shellcheck on `examples/`; `apps/api/scripts/*.sh` is not checked at all.

**Acceptance criteria.**
- A CI step runs `shellcheck` on `setup.sh`, `deploy/migrate/migrate.sh`
  and `apps/api/scripts/*.sh` (the `examples` job is the pattern to copy).
- Existing warnings are fixed, or disabled inline with a comment saying
  why.
- `npm run verify` and the `compose` job still pass.

Files: `.github/workflows/ci.yml`, `setup.sh`, `deploy/migrate/migrate.sh`.

---

## 2. Add a docs index (`docs/README.md`)

Labels: `good first issue`, `docs`

**Context.** `docs/` has seven guides and no index; the README's header
links five of them and leaves out `docs/ingest-api.md` and
`docs/business-views.md`. Browsing `docs/` on GitHub shows a bare file list.

**Acceptance criteria.**
- `docs/README.md` lists every guide in `docs/` with one line on what it
  covers, grouped (install and operate / connect agents / business layer).
- The README's link bar or Architecture section links to it.

Files: `docs/*.md`, `README.md`.

---

## 3. Hand-written MCP config for the clients only the web app documents

Labels: `good first issue`, `docs`

**Context.** `docs/connect-agents.md` shows configurations for Claude
Code, Cursor, Codex and Claude Desktop, then says "Others (Windsurf, Zed,
VS Code / Copilot, Gemini CLI, Cline, Goose…): Agents → Add agent shows the
exact snippet". The web app does generate them
(`apps/web/src/lib/agent-providers.tsx`, `apps/web/src/lib/agent-instructions.ts`),
but someone reading the docs before installing cannot see them.

**Acceptance criteria.**
- `docs/connect-agents.md` gains a short section per client (start with
  VS Code and Gemini CLI) with the same snippet the web app generates for
  token auth and, where supported, OAuth.
- The snippets match `agent-instructions.ts` (copy from it, do not
  reinvent).

Files: `docs/connect-agents.md`, `apps/web/src/lib/agent-instructions.ts`.

---

## 4. Add a Python version of the agent-loop example

Labels: `good first issue`, `examples`

**Context.** `examples/` shows the agent loop (brief → create a task →
append `## Result` → done) with curl (`examples/curl/agent-loop.sh`) and the
TypeScript MCP SDK (`examples/node/agent-loop.mjs`). Many agent builders
work in Python.

**Acceptance criteria.**
- `examples/python/agent_loop.py` does the same steps with the official
  `mcp` Python SDK over Streamable HTTP, reading `BCONTEXT_URL`,
  `BCONTEXT_WORKSPACE` and `BCONTEXT_TOKEN`.
- A `requirements.txt` (or `pyproject.toml`) pins the SDK's minimum version.
- `examples/README.md` lists it, and you ran it against a local instance
  (`docker compose up -d`) — paste the output in the PR.

Files: `examples/node/agent-loop.mjs` (reference), `examples/README.md`.

---

## 5. `reembed-stale.ts` should read `SUPABASE_URL` and say how to run it

Labels: `good first issue`, `api`

**Context.** `docs/self-hosting.md` (AI section) says
"`apps/api/scripts/reembed-stale.ts` re-embeds a workspace" after an
embedding model change, but not how to run it. The script reads only the
legacy `NEXT_PUBLIC_SUPABASE_URL` (`main()`, line ~62), while the API reads
`SUPABASE_URL` first and keeps the `NEXT_PUBLIC_*` fallback only until
2026-12-31 (`apps/api/src/lib/env.ts`). Its header also says it needs
`tsx`, which is not a dependency of `bcontext-api`.

**Acceptance criteria.**
- The script reads `SUPABASE_URL`, falling back to
  `NEXT_PUBLIC_SUPABASE_URL`, and its error message names both.
- Its header comment and the AI section of `docs/self-hosting.md` give a
  command that works from a checkout (e.g. `npx tsx …` with the variables to
  set).
- `npm run verify -w bcontext-api` passes.

Files: `apps/api/scripts/reembed-stale.ts`, `apps/api/src/lib/env.ts`,
`docs/self-hosting.md`.

---

## 6. Don't drop a node's chunks when the new embeddings can't be stored

Labels: `good first issue`, `api`, `rag`

**Context.** `embedNode` in `apps/api/src/lib/rag/embed.ts` deletes a
node's rows in `embeddings` and then inserts the new ones, as two separate
calls. The vector column is `vector(1536)`; with a model that returns
another size (`docs/self-hosting.md` names `nomic-embed-text`, 768, and
`mxbai-embed-large`, 1024) the insert fails after the delete, so the node
loses its previous chunks. The same rows carry the keyword-search index
(`content_tsv`, migrations `0003_hybrid_search.sql` and
`0006_contextual_retrieval.sql`), so the node drops out of keyword results
too.

**Acceptance criteria.**
- Before deleting, `embedNode` checks every new vector has length 1536 and
  throws a clear error (naming `EMBEDDING_MODEL` and the size it got) if
  not, leaving the existing rows untouched.
- A test in `apps/api/src/lib/rag/embed.test.ts` covers it.
- `npm run verify -w bcontext-api` passes.

Files: `apps/api/src/lib/rag/embed.ts`, `apps/api/src/lib/rag/embed.test.ts`.
