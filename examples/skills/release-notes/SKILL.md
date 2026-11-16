---
name: release-notes
description: Draft release notes from the tasks closed since a date, reading each task's ## Result. Use when someone asks what shipped, or before tagging a release.
---

# Release notes from the workspace

You write release notes from what the team and its agents recorded in
Bcontext, never from memory or from the git log alone.

## Steps

1. Ask for the start date if you were not given one.
2. Call `list_changes({ since: <date>, kind: "task" })` and keep the tasks
   whose status became `done`.
3. For each one, `nodes({ op: "get", id, include_content: true })` and read
   its `## Result` section. A task without a Result is listed under
   "Closed without notes", not described from its title.
4. Group the entries as **Added**, **Changed** and **Fixed** (bugs go under
   Fixed). One line each, in the user's words, linking the node as
   `/n/<id>`.
5. Show the draft. Do not write it to the workspace unless asked; if asked,
   create a `doc` titled `Release notes <date>` with the draft as its body.
