#!/usr/bin/env bash
# A scripted stand-in for an LLM agent: acts only through `genie agent`, like a real one.
# The last argument is the turn's message.
set -euo pipefail
msg="${!#}"
g() { "$GENIE_BIN" agent "$@"; }
echo "turn of $GENIE_AGENT_NAME ($GENIE_AGENT_ROLE)"
case "$GENIE_AGENT_ROLE" in
  orchestrator)
    if grep -q "in the inbox from the owner" <<<"$msg"; then
      id=$(grep -o 'New task [A-Z]*-[0-9]*' <<<"$msg" | head -1 | awk '{print $3}')
      g update --task "$id" -d "Export orders as CSV" -a "file downloads" --merge-strategy "merge by orchestrator"
      g status ready --task "$id" --note "refined"
      g spawn "$id" --template pair --note "small change"
    fi
    if grep -q "verdict" <<<"$msg"; then
      id=$(g list --status approved | awk 'NR==1{print $1}')
      [ -n "$id" ] && g status done --task "$id" --note "accepted"
    fi
    ;;
  executor)
    if grep -q "## Kickoff" <<<"$msg"; then
      if [ "${FAIL_ONCE:-}" = "1" ] && [ ! -f "$GENIE_MARK" ]; then touch "$GENIE_MARK"; echo "simulated crash" >&2; exit 3; fi
      g status in_progress
      g artifact --kind test-report --name tests.md --text "cargo test: ok"
      g status review --note "ready for review"
      reviewer=$(g team | awk '/\(reviewer\)/{print $2; exit}')
      g send "$reviewer" "please review" --intent question
    fi
    ;;
  reviewer)
    if grep -q "## Kickoff" <<<"$msg"; then g set-status "waiting for the executor"; fi
    if grep -q "please review" <<<"$msg"; then
      g check 1
      g artifact --kind review --name review.md --text "LGTM"
      g status approved --note "all criteria met"
      g send orchestrator "approved" --intent verdict
    fi
    ;;
esac
