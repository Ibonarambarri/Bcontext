# Contributing

Thanks for helping. Bcontext is maintained by one person, so the process is
small. Issues labelled
[`good first issue`](https://github.com/Ibonarambarri/Bcontext/labels/good%20first%20issue)
are scoped to be picked up without knowing the whole codebase.

## Before you start

1. **Open an issue first** for anything bigger than a bug fix, so we can agree
   on the shape before you write it.
2. Fork, branch from `main`, and keep the PR to one change.

## Set up

You need Node 24 and, to run the whole stack, Docker with Compose v2.

```bash
make install        # npm ci at the root
make verify         # typecheck, lint, test and build every workspace
make up             # the full stack on http://localhost:8080
```

`make help` lists the rest. Each target is a thin wrapper around an `npm` or
`docker compose` command, so you can run those directly. The layout of the
repository (`apps/api`, `apps/web`, `packages/contract`, `plugin/`) is in
[AGENTS.md](AGENTS.md).

## Rules that CI or review will hold you to

- `npm run verify` passes — CI runs the same thing. `VERIFY_QUICK=1` skips
  the Next.js build while you iterate.
- A change that touches the API and the web changes the contract
  (`packages/contract`) first; the web only talks to the API over HTTP.
- Database changes are a **new** migration (never edit an existing one), and a
  fresh `docker compose down -v && docker compose up -d --build` applies it.
- If you change MCP tools, env variables, the compose stack or setup, update
  the README / `.env.example` / `docs/` in the same PR. A change to the MCP
  tools also updates `plugin/skills/bcontext/SKILL.md`.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user or operator would notice.

`AGENTS.md` lists the repository's rules in full (they apply to humans too).

## The pull request

Describe what changed and why, and how you tested it; the PR template asks
for exactly that.

By contributing you agree that your contribution is licensed under the
AGPL-3.0-only, the license of this project. Everyone taking part is expected
to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security issues

Please do not open a public issue; see [SECURITY.md](SECURITY.md).
