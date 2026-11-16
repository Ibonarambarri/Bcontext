# Launch checklist

## Before launch day (all must be true)

- [ ] `docs/open-source-polish` is merged to `main` and CI is green.
- [ ] The demo GIF is recorded and replaces the README placeholder (an agent
      calling `brief`, closing a task with `## Result`, the result showing
      in the web app).
- [ ] GitHub Releases exist for the tags `v0.2.0` … `v0.4.3` (only `v0.1.0`
      has one today); the latest has release notes and points at the GHCR
      images.
- [ ] A fresh clone on a clean machine follows the README quickstart to a
      working workspace, and `examples/curl/agent-loop.sh` runs against it.
- [ ] Repository description, topics and homepage set ([github.md](github.md)).
- [ ] Social preview image uploaded.
- [ ] Private vulnerability reporting enabled (CONTRIBUTING.md and
      SECURITY.md point to it).
- [ ] Discussions enabled with a Q&A category.
- [ ] 5–10 `good first issue` issues opened ([good-first-issues.md](good-first-issues.md)).
- [ ] You have a free day to answer comments.

## When to post

Common practice, not measured data: Show HN posts on **Tuesday to
Thursday, around 8–10am US Eastern** (14:00–16:00 in Spain) tend to meet the
most readers while staying on /newest long enough to be seen. Avoid US
holidays and the days of big launches in the same space.

## Order

1. **Day 1, morning US Eastern — Show HN** ([show-hn.md](show-hn.md)), first
   comment immediately after.
2. **Day 1, an hour later — X thread and LinkedIn**, linking the repo (not
   the HN thread, and never asking for votes).
3. **Day 2 — r/mcp and r/ClaudeAI.**
4. **Day 3–4 — r/selfhosted** (on its project day if it has one) **and
   r/LocalLLaMA.**
5. **Day 5–7 — dev.to/Hashnode article**, linking the repo; r/opensource.
6. **Week 2 onwards — awesome lists**, one at a time
   ([awesome-lists.md](awesome-lists.md)).

## Answering comments

- Answer every substantive comment the same day, from your own account.
  Thank people for criticism and engage with it; do not argue about taste.
- Concede real limitations plainly (stack size, one maintainer, embedding
  dimensions, AGPL). Do not promise dates.
- Turn concrete bug reports and requests into GitHub issues and reply with
  the link.
- If someone asks how it compares to X and you have not used X, say so.
- Never upvote from other accounts, ask friends to vote, post in vote-ring
  groups, or buy stars or followers. HN and Reddit detect it and it gets
  the post and the account penalised.

## After

- [ ] Note the questions people asked; the recurring ones become README or
      docs changes.
- [ ] Triage new issues within the week; label easy ones `good first issue`.
- [ ] Thank first-time contributors in the release notes.
