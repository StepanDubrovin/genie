---
name: genie-workflow
description: Use the local genie task tracker and team mailboxes from the shell (the `genie` CLI). Use when working in a project that has a `.genie/` directory, when asked about genie tasks, teams, their status or artifacts, or when genie tools are not available in the current harness.
---

# genie CLI

`genie` is the local task tracker used by the orchestrator and focus teams. Inside pi with the genie extension, prefer the `genie_task` / `team_*` tools; use the CLI from other harnesses or for quick inspection.

The tracker is a SQLite database in `.genie/`. Never read or edit files under `.genie/` directly (in pi this is blocked) — go through the CLI, including for artifacts.

```bash
genie board                     # tasks grouped by status + active teams
genie ls [--all] [--status review,needs_owner]
genie ready                     # ready queue
genie show G-7 [--history]      # description, criteria, plan, notes, artifact list, comments
genie artifact-show G-7 2       # print artifact #2 (e.g. the review); --out FILE for binaries
genie comment G-7 "text" --kind progress|decision|question|review|handoff|note
genie artifact G-7 --file report.md --kind test-report
echo "# review" | genie artifact G-7 --stdin --kind review --name review.md
genie status G-7 review -m "submitted, tests green"
genie check G-7 2               # tick acceptance criterion #2
genie new "title" -d "details"  # as the owner: lands in the inbox and wakes the orchestrator
genie teams | genie team G-7 | genie mail G-7
genie send G-7 bender "message" # address members by their name (see `genie team G-7`), or `all` / `orchestrator`
genie team G-7 add tester [name] [--model provider/id] [-m "what to do"]
genie team G-7 remove bender    # stop a member and drop it from the team
genie team G-7 stop [--rm-worktree]
genie team G-7 delete [--rm-worktree]   # stop and delete with chat history
genie web [--tailscale]         # Linear-style web UI (list, board, team chat)
```

Add `--json` for machine-readable output. Identity comes from `GENIE_ROLE` / `GENIE_MEMBER`; without them you act as the owner (`human`, all permissions). Comments and status changes made as the owner wake the orchestrator.

## Workflow

`inbox → draft → refining → ready → in_progress → review ⇄ changes_requested → approved → done`, plus `needs_owner` (waiting for the owner's decision; the question is in the task) and `cancelled`.

- Only the orchestrator (or the owner) moves tasks to `draft`, `ready`, `needs_owner`, `done` and `cancelled`.
- `review` is the executor's step, `approved` the reviewer's (the reviewer or tester can send it back with `changes_requested`).
- To answer a `needs_owner` question as the owner, comment on the task (`genie comment G-7 "…"`); the orchestrator picks it up.

## Teams

Members have playful names shown as "Name — role" (e.g. Sherlock — analyst, Bender — executor); the lowercase name is their address. `genie team G-7` shows each member's state: `active`, `starting`, `stopped`, or `lost` (no heartbeat and no process). Lost members are restarted by the orchestrator with `team_recover`, or from pi with `/genie recover [G-7]`; their conversation continues from the saved session. Closing a task (`done`/`cancelled`, also from the web board) stops its team automatically.
