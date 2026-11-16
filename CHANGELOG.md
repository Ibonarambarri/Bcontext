# Changelog

Notable changes to Bcontext. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/); while it is 0.x, a minor version
may change behaviour. Each release tag publishes `ghcr.io/ibonarambarri/bcontext-api`
and `bcontext-web` images for amd64 and arm64.

## [Unreleased]

### Added
- `examples/`: the agent loop (`brief` → task → `## Result`) over raw
  MCP-over-HTTP with curl and with the MCP TypeScript SDK, a `SKILL.md` and
  the script that imports it, and client configuration for Claude Code,
  Cursor and Codex.
- A `Makefile` wrapping setup, start-up with a health wait, logs, verify and
  the examples.
- `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms and this changelog.

### Changed
- The web verify (and so CI) runs ESLint; CI checks the examples.

### Security
- Next.js 16.4.6, out of the range of GHSA-mfr8-8qww-v76h (16.3.0 – 16.4.4).

## [0.4.3] - 2026-11-12

### Fixed
- Partial months are compared like for like, and runway is taken from
  closed months only.
- An MRR history no longer draws an invented movements axis.
- Month-to-date KPI titles stay whole; a zero change has no sign.

### Added
- A number field can be shown as money in the reporting currency.

## [0.4.2] - 2026-11-12

### Added
- `promotes_from` on record types, field totals, ingest examples specific to
  each business model and month-to-date KPI labels.

### Fixed
- A dataset row that lacks some of the mapped columns can still be promoted.
- One money format across the web app.

## [0.4.1] - 2026-11-12

### Fixed
- Follow-ups from the v0.4.0 browser pass: only fitting promote targets are
  offered, KPI sides are renamed, bookings are followed to their end, and an
  ingest sync made of single PUTs folds into one What's new entry.
- Heatmaps keep the weeks nobody booked as empty columns.

## [0.4.0] - 2026-11-12

### Added
- **What's new**: the review surface for what agents and teammates wrote
  since your last visit, with proposals to accept or dismiss on top.
- **Ask the brain…** in the workspace header: answers from the workspace,
  citing the nodes they come from.
- **Business layer**: record types (`account`, `deal`, `zone`…) written as
  ordinary kinds with validated fields, a write-only ingest API for records
  and events, daily and monthly metric rollups (MRR, churn, NRR, GMV, take
  rate, runway), record views (pipeline boards, tables, KPI dashboards,
  heatmaps) and templates for b2b, b2c and marketplace workspaces. Exposed
  over REST and MCP without new tools. See
  [docs/ingest-api.md](docs/ingest-api.md) and
  [docs/business-views.md](docs/business-views.md).
- Migrations 0103 and 0104.

### Changed
- Empty states point at connecting an agent instead of manual seeding.

### Fixed
- A non-uuid node id answers not found instead of a 500.
- The sign-in form keeps the email after a refused attempt.

## [0.3.0] - 2026-11-12

### Added
- The capability gateway is back on the workspace-only model: register other
  MCP servers in **Tools**, grant them per agent, and agents reach them with
  `capability_search` / `capability_call` (migration 0102).

## [0.2.0] - 2026-11-12

### Changed
- The workspace is the single top-level entity: organizations are gone
  (migrations 0100, 0101). Endpoints written as `/mcp/<org>/<workspace>` keep
  working.
- A narrower product: Nexos, the external-tool integrations and the meeting
  bot were removed (migration 0099).
- Web fonts are vendored and loaded with `next/font/local`, so the build does
  not fetch from Google.

### Added
- A copy-paste prompt to install Bcontext with a coding agent
  ([docs/install-with-an-agent.md](docs/install-with-an-agent.md)).
- The Claude Code plugin lives in this repository (`plugin/`).
- Running behind an existing reverse proxy.
- Health checks for caddy, the worker and PostgREST; `/api/health` checks the
  PostgREST data path.

### Fixed
- The API answers 503, not 401, when the token store cannot be reached.

## [0.1.0] - 2026-10-14

First open-source release.

[Unreleased]: https://github.com/Ibonarambarri/Bcontext/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/Ibonarambarri/Bcontext/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Ibonarambarri/Bcontext/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Ibonarambarri/Bcontext/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Ibonarambarri/Bcontext/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ibonarambarri/Bcontext/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ibonarambarri/Bcontext/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ibonarambarri/Bcontext/releases/tag/v0.1.0
