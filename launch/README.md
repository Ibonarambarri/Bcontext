# Launch kit

Drafts and checklists for announcing Bcontext. Nothing here is code, and
nothing here ships: the Docker images are built from `packages/contract`,
`apps/api` and `apps/web` only (each Dockerfile copies those paths, not the
whole build context), and no package is published from this repository.

Everything is a draft for the maintainer to edit and post by hand. Nothing in
it may be posted by a bot, from a second account, or alongside a request for
votes or stars.

| File | What it is |
|---|---|
| [checklist.md](checklist.md) | What must be true before launch day, the order to post in, how to answer comments |
| [github.md](github.md) | Repository description, topics, homepage and social preview |
| [show-hn.md](show-hn.md) | Show HN title and the maintainer's first comment |
| [reddit.md](reddit.md) | One post per subreddit, with each one's self-promotion norms |
| [devto-article.md](devto-article.md) | Long-form article for dev.to or Hashnode |
| [x-thread.md](x-thread.md) | Thread for X |
| [linkedin.md](linkedin.md) | LinkedIn post |
| [awesome-lists.md](awesome-lists.md) | Curated lists to submit to, with the entry and PR text for each |
| [good-first-issues.md](good-first-issues.md) | Small, verified issues to open with the `good first issue` label |

## Rules for every draft

- Only claims the repository backs up. No user counts, benchmarks, star
  counts or quotes that did not happen.
- Say what it does not do: one maintainer, best-effort support, a heavier
  stack than a single binary (Postgres, Supabase Auth/Storage, Caddy), and
  semantic search needs 1536-dimensional embeddings.
- Lead with shared memory for teams of agents over MCP. The business layer
  (record types, ingest API, SaaS metrics) is one feature among the others.
- Replace every `[TODO: …]` with your own words or delete it.
