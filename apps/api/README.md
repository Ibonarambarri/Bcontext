# bcontext-api

The API process of Bcontext and everything behind it: the REST API, the MCP
server, the permission engine, the queue worker, the error collector and the
database migrations. One image, three processes (`BCONTEXT_PROCESS=api |
worker | errors`). The web app is `apps/web`; the types both share are
`packages/contract`. To run the whole product, see the repository's root
`README.md`.

> Not a Notion or Linear alternative. A retrieval-grade, MCP-first memory for
> teams that work with agents — Markdown + typed nodes as the truth.

## What's inside

- **MCP server** at `/mcp` and, per workspace, `/mcp/<workspace>`
  (Streamable HTTP, stateless; the pre-0100 `/mcp/<org>/<workspace>` path is
  still served as an alias): 25 tools —
  `brief`, `nodes` / `nodes_write`, `subtasks` / `subtasks_write`, `goals` /
  `goals_write`, `data` / `data_write`, `tags` / `tags_write`, `views` /
  `views_write`, `links_write`, `ingest` / `ingest_write`, `skills` /
  `skills_write` / `skills_run`, `admin` / `admin_write`, `ask_rag`,
  `list_changes`, `list_workspaces`, `ping` (`admin` and `admin_write` need
  the admin verb). `tools/list` is per-principal: what a token cannot do is
  not shown. This is the agent surface; the server `instructions` from
  `initialize` are the manual.
- **`ask_rag`** (`src/lib/rag`): the question tool for agents — retrieval
  within the caller's grant, rerank, and a cited answer (`synthesize:false`
  for the hits only). Grants apply before rerank and before any model
  context.
- **REST** under `/api/*` for humans and automations that cannot speak MCP —
  the web app, scripts, CI hooks, curl. Not an agent surface (stated in
  `/.well-known/agents.json` and `/llms.txt`); `/api/agents/{context,write}`
  keep working for the automations that call them.
- **Permission engine** (`src/lib/auth`): grants per `(principal, workspace)`
  with verbs and reach; every route opens a workspace through `openWorkspace`.
  RLS is not evaluated at runtime — the grant model is the authorisation.
  Agent tokens (`bctx_live_…`) or OAuth 2.1 with PKCE, dynamic client
  registration and resource indicators (RFC 8707): a grant made through
  `/mcp/<workspace>` is that workspace's alone.
- **Workspaces and accounts**: the workspace is the only top-level entity —
  members with a role (`owner`, `admin`, `editor`, `viewer`), agents,
  invitations and usage all belong to one, and its slug is unique across the
  instance. A signed-in person creates a workspace (`POST /api/workspaces`)
  and becomes its owner; others join by invitation.
  `WORKSPACE_CREATION=open` (default) also allows self-service signup
  (`POST /api/signup`); `admin` keeps both to the instance admins
  (`ADMIN_EMAILS`), who create workspaces and invite their owners. No plans,
  quotas or billing: usage is counted per workspace for administrators to
  read, never enforced.
- **Knowledge graph**: docs, tasks (with subtasks), decisions, meetings, bugs,
  ADRs, goals, datasets, skills, credentials as typed nodes; H2 headings
  become addressable blocks (`/n/<id>#<slug>`); typed edges (`blocked_by`,
  `references`, `supersedes`, `contributes_to`…).
- **Retrieval**: pgvector + keyword fallback, scoped (`view`, `tags`,
  `selection`, `neighborhood`), every hit carries a paste-ready `ref`.
- **Realtime** on the same listener (`ws`): presence, events and Yjs frames
  at `/realtime/ws/:workspaceId` and `/realtime/collab/:nodeId`, authorised
  by the same grants; fan-out between processes over Postgres `LISTEN/NOTIFY`.
- **Worker** (`pg-boss`): webhook drain, scheduled skills, error retention,
  auto-archive — same image as the API, `BCONTEXT_PROCESS=worker`.
- **Error collector** (`src/errors`): the third process of the image
  (`BCONTEXT_PROCESS=errors`); API, worker, web and browser report to it,
  the admin panel reads `error_groups` / `error_events`.
- **Contract** (`../../packages/contract` → `@bcontext-dev/contract`): types, view
  query schema, agent vocabularies, the API route table and pure helpers the
  web shares.

## Stack

- Node 24, TypeScript strict, [Hono](https://hono.dev) + `@hono/node-server`
- Route modules in `src/app/api/**/route.ts` (framework-neutral `Request` →
  `Response` handlers in a file-per-route layout), served through a
  generated route table
- Postgres 15 + pgvector via Supabase (Auth, Storage, PostgREST) — self-hosted
- Vercel AI SDK v6 through AI Gateway or any OpenAI-compatible server
  (Ollama, LiteLLM — `OPENAI_BASE_URL`); models in `CHAT_MODEL`,
  `EXTRACT_MODEL`, `EMBEDDING_MODEL`… (`src/lib/ai/provider.ts`)
- Vitest (~2 200 tests, no database needed: an in-memory demo store backs them)

## Development

From the repository root, `npm install` once. Then, against a local Supabase
(`docs/ops/local-stack.md`):

```bash
cd apps/api
supabase start                 # local Supabase: applies every migration
./scripts/local-env.sh         # writes .env.development.local
npm run build:api && set -a && . ./.env.development.local && set +a && node dist/api.cjs
# → http://localhost:4000   /healthz  /api/health  /mcp
```

Talk to the MCP from a terminal without an MCP host:

```bash
BCONTEXT_MCP_URL=http://localhost:4000/mcp BCONTEXT_MCP_TOKEN=bctx_live_… \
  node scripts/mcp-client.mjs tools/call nodes '{"op":"list","kind":"task","unblocked":true}'
```

### Environment

Read through `src/lib/env.ts`; without Supabase the in-memory demo store
takes over. The `NEXT_PUBLIC_*` names are legacy aliases read as a fallback
**until 2026-12-31**. `.env.example` lists everything, required first; the
ones that matter first:

| Key | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | api, worker | Supabase (Auth, PostgREST, Storage) |
| `SUPABASE_PUBLIC_URL` | api | the same gateway as browsers reach it, when different (links, session cookie name) |
| `DATABASE_URL`, `DATABASE_SSL` | api, worker | direct Postgres: `pg-boss`, transactional webhook enqueue, realtime fan-out over `LISTEN/NOTIFY` |
| `APP_URL`, `ALLOWED_ORIGINS` | api, worker | where the web app lives (links, trusted browser origin) and extra origins; `APP_URL` is required in production (boot fails without it), `http://localhost:3000` otherwise |
| `ADMIN_EMAILS` | api | who may open `/admin`; unset = nobody |
| `AI_GATEWAY_API_KEY` or `OPENAI_BASE_URL` (+ `OPENAI_API_KEY`), `CHAT_MODEL`, `EXTRACT_MODEL`, `EMBEDDING_MODEL` | api, worker | the AI backend: AI Gateway, or an OpenAI-compatible server (wins when set; no rerank). Embeddings must be 1536-dimensional |
| `API_PORT` (4000), `BCONTEXT_PROCESS` (`api` \| `worker` \| `errors`) | image | which process the container runs |
| `REALTIME_SECRET` | api, worker | `POST /realtime/broadcast` for a process without `DATABASE_URL` |
| `ERRORS_INGEST_URL`, `ERRORS_INGEST_KEY`, `ERRORS_*` | all | the error collector; unset = reporting is a no-op |
| `RESEND_API_KEY`, `EMAIL_FROM`, `INSTANCE_NAME` | api, worker | email: no sender default, so without both nothing is sent |
| `WORKSPACE_CREATION` (`open` \| `admin`) | api | who may sign up and create workspaces (`admin` = only `ADMIN_EMAILS`). The pre-0100 name `ORG_CREATION` is still read when this is unset |

## Repo layout

```
src/
  api/                    Hono app: adapter, generated route table, realtime, parity tests
  app/api/**/route.ts     the HTTP handlers (framework-neutral)
  app/.well-known, llms.txt, install, mcp     the public discovery surface
  lib/
    auth/                 grants, scopes, tokens, OAuth 2.1 — the permission engine
    mcp/                  the MCP server, its tools and its HTTP transport
    rag/                  ask_rag, retrieval and scoping
    graph/                graph snapshots and entity linking after each write
    realtime/, collab/    hub + client (ws), Yjs
    queue/                pg-boss queues and cadence
    storage/, supabase/   the data layer (service role; grants do the scoping)
  worker/                 the queue worker entrypoint
  errors/                 the error collector process
supabase/migrations/      the schema, 0001 … 0099 (applied by deploy/migrate/migrate.sh in compose)
scripts/                  verify.sh, build-*, gen-api-routes, mcp-client, rag-eval…
docs/
  ops/                    local-stack, worker
  credentials.md
```

## Development rules

- **Framework-neutral handlers.** No `next/*` anywhere; `build:api`,
  `build:worker` and `build:errors` fail if it creeps back in.
- **Every handler is reachable through the generated route table**
  (`npm run gen:api-routes`); `routes.generated.test.ts` guards it.
- **The contract is self-contained** (`contract-is-self-contained.test.ts`);
  a change that touches API and web changes the contract first.
- **Multi-workspace scoping on every route** through `openWorkspace`.
- **Body writes over MCP require `if_updated_at`**; a 409 means re-fetch,
  merge, retry.
- **Comments say why.** No phase codes, no changelog narrative in code.

## Verification

`npm run verify -w bcontext-api` (`scripts/verify.sh`: contract build,
typecheck, tests, the three bundles). CI runs the same script on every pull
request.

## Observability

Every route is wrapped in `withRoute`: `X-Request-Id` / `X-Correlation-Id` are
accepted or generated and echoed on every response, and each request logs
single-line JSON (`request.started` / `request.completed` / `request.failed`,
`auth.failed`, `rate_limit.denied`) to stdout/stderr — no bodies, no bearer
tokens. Failures go to the error collector; poll `/api/health` from outside
for uptime.

## Agents, in one paragraph

Connect an MCP host to `https://<your domain>/mcp/<workspace>` with a
workspace agent token (`bctx_live_…`, created in the web app under Agents) or
through OAuth 2.1 — the per-workspace URL is the one for a project's own
`.mcp.json`, and OAuth through it yields a token bound to that workspace.
`/mcp` alone takes the workspace from the token or from
`X-Bcontext-Workspace`. Read the server `instructions` from `initialize`, then
`brief`, `list_changes({ since })` and `nodes({ op: "list", kind: "task",
unblocked: true })`. The repository's `docs/connect-agents.md` walks through
the setup for each client.
