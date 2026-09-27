---
name: genie-workflow
description: Use the local genie task tracker and team mailboxes from the shell (the `genie` CLI). Use when working in a project that has a `.genie/` directory, when asked about genie tasks, teams, or their status, or when genie tools are not available in the current harness.
---

# genie CLI

`genie` is the local task tracker used by the orchestrator and focus teams. Inside pi with the genie extension, prefer the `genie_task` / `team_*` tools; use the CLI from other harnesses or for quick inspection.

```bash
genie board                     # tasks grouped by status + active teams
genie ls [--all] [--status review,approved]
genie ready                     # ready queue
genie show G-7 [--history]
genie comment G-7 "text" --kind progress|decision|question|review|handoff|note
genie artifact G-7 --file report.md --kind test-report
echo "# review" | genie artifact G-7 --stdin --kind review --name review.md
genie status G-7 review -m "submitted, tests green"
genie check G-7 2               # tick acceptance criterion #2
genie teams | genie team G-7 | genie mail G-7
genie send G-7 executor "message"   # write to a team member
```

Add `--json` for machine-readable output. Identity comes from `GENIE_ROLE` / `GENIE_MEMBER`; without them you act as `human` (all permissions).

Workflow: `draft → refining → ready → in_progress → review ⇄ changes_requested → approved → done`. Only the orchestrator (or a human) moves tasks to `ready` and `done`; `review` is the executor's step and `approved` the reviewer's.
