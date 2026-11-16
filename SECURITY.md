# Security policy

Bcontext stores a team's tasks, decisions and documents, and agent tokens
that can write to them, so security reports are welcome and taken seriously.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release
gets security fixes; upgrade with `git pull && docker compose pull &&
docker compose up -d` (see [Updating](docs/self-hosting.md#updating): the
checkout and the images must move together).

| Version | Supported |
|---|---|
| latest 0.4.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
(<https://github.com/Ibonarambarri/Bcontext/security/advisories/new>).

Include what you can of:

- the affected component (API, MCP server, web app, worker, the compose
  stack, the plugin) and version or commit;
- the steps to reproduce, or a proof of concept;
- the impact as you see it (for example: a token reaching another
  workspace, reading a node without a grant, a secret leaking into logs).

Bcontext is maintained by one person on a best-effort basis, so there is no
guaranteed response time; you can expect an acknowledgement and a plan, and
credit in the advisory if you want it. Please give a reasonable time to ship
a fix before disclosing publicly.

## Scope

In scope: the code in this repository and the default configuration written
by `setup.sh` and `docker-compose.yml`.

Out of scope: vulnerabilities in upstream images (Supabase, Postgres, Caddy,
Kong) that are not caused by how Bcontext configures them — report those
upstream; issues that need an already-compromised host or a leaked admin
credential; and rate-limit or denial-of-service findings without a concrete
amplification.

## Hardening notes for operators

- Keep `.env` private: it holds the JWT secret, the service-role key and the
  Postgres password. `setup.sh --rotate` regenerates every secret except the
  Postgres password.
- Give agent tokens the narrowest scopes they need (`nodes:read` for a
  read-only agent); revoke unused tokens in **Agents**.
- Caddy is the only service with published ports; keep it that way.
