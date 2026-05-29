#!/usr/bin/env bash
# F033.5 — SessionStart hook.
#
# Fires when cc launches in this repo. Calls cardmem_session_start to
# UPSERT cc_sessions + retrieve active_project / in_progress / review_queue
# / recent_audit / last_snapshot. Prints a <projects:state> block on stdout
# so cc orients instantly without burning tokens re-reading PLAN.md.
#
# Inputs (stdin JSON from cc):
#   { session_id, transcript_path, cwd, ... }
#
# Env:
#   BUDDY_SESSION_NAME — from ccb wrapper. Stored in cc_sessions so the
#                        notify-bridge knows where to send card events.

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/_common.sh"

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
if [[ -z "$session_id" ]]; then
  # cc didn't pass a session_id (older cc version, or hook invoked manually).
  # Fall back to a stable id derived from the cwd so reruns aren't multiplied.
  session_id="cc-$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-12)"
  hook_log "session-start: synthesized session_id=$session_id from cwd"
fi

repo=$(resolve_repo)
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

args=$(
  jq -nc \
    --arg sid "$session_id" \
    --arg repo "$repo" \
    --arg branch "$branch" \
    --arg buddy "${BUDDY_SESSION_NAME:-}" \
    --arg spawnedCard "${CARDMEM_SPAWNED_CARD_ID:-${PROJECTS_SPAWNED_CARD_ID:-}}" \
    --arg spawnedBranch "${CARDMEM_SPAWNED_BRANCH:-${PROJECTS_SPAWNED_BRANCH:-}}" \
    --arg parent "${CARDMEM_PARENT_SESSION_ID:-${PROJECTS_PARENT_SESSION_ID:-}}" \
    '{ session_id: $sid }
       + (if $repo  != "" then { repo:  $repo  } else {} end)
       + (if $branch!= "" then { branch:$branch} else {} end)
       + (if $buddy != "" then { buddy_session_name: $buddy } else {} end)
       + (if $spawnedCard  != "" then { spawned_card_id: $spawnedCard } else {} end)
       + (if $spawnedBranch!= "" then { spawned_branch: $spawnedBranch } else {} end)
       + (if $parent       != "" then { parent_session_id: $parent } else {} end)'
)

result=$(call_mcp cardmem_session_start "$args")
if [[ -z "$result" ]]; then
  hook_log "session-start: no result from cardmem_session_start (server down?)"
  exit 0
fi

# Build the <projects:state> block. Keep it tight — capped budget per docs.
printf '<projects:state>\n'

active=$(printf '%s' "$result" | jq -r '.active_project // empty')
if [[ -n "$active" ]]; then
  proj_name=$(printf '%s' "$result" | jq -r '.active_project.name')
  proj_repo=$(printf '%s' "$result" | jq -r '.active_project.github_repo_full_name // ""')
  printf '  Project: %s' "$proj_name"
  [[ -n "$proj_repo" ]] && printf ' (%s)' "$proj_repo"
  printf '\n'
fi

# F064 — surface queue-drain mode so a session can verify whether it
# inherited the project's auto_pickup_mode toggle (otherwise invisible).
qd_session=$(printf '%s' "$result" | jq -r '.queue_drain.session_auto_pickup_mode // "off"')
qd_project=$(printf '%s' "$result" | jq -r '.queue_drain.project_auto_pickup_mode // "off"')
qd_active=$(printf '%s' "$result" | jq -r '.queue_drain.effective_active // false')
if [[ "$qd_session" == "queue-drain" || "$qd_project" == "queue-drain" ]]; then
  printf '  Queue-drain: session=%s project=%s active=%s\n' "$qd_session" "$qd_project" "$qd_active"
fi

in_progress_count=$(printf '%s' "$result" | jq '.in_progress | length')
if [[ "$in_progress_count" -gt 0 ]]; then
  printf '  In progress:\n'
  printf '%s' "$result" | jq -r \
    '.in_progress[] | "    - " + (.f_number // .global_slug) + " · " + .title + " (" + .priority + (if .story_points then ", " + (.story_points|tostring) + " SP" else "" end) + ")"'
fi

review_count=$(printf '%s' "$result" | jq '.review_queue | length')
if [[ "$review_count" -gt 0 ]]; then
  printf '  Review queue:\n'
  printf '%s' "$result" | jq -r \
    '.review_queue[] | "    - " + (.f_number // .global_slug) + " · " + .title'
fi

audit_count=$(printf '%s' "$result" | jq '.recent_audit | length')
if [[ "$audit_count" -gt 0 ]]; then
  printf '  Recent activity:\n'
  printf '%s' "$result" | jq -r \
    '.recent_audit[] | "    - " + (.timestamp | sub("\\..+"; "Z")) + "  " + .action + "  " + (.result_summary // "")' \
    | head -5
fi

snapshot=$(printf '%s' "$result" | jq -r '.last_snapshot // empty')
if [[ -n "$snapshot" ]]; then
  snap_fnums=$(printf '%s' "$result" | jq -r '.last_snapshot.in_progress_f_numbers | join(", ")')
  snap_notes=$(printf '%s' "$result" | jq -r '.last_snapshot.notes // ""')
  printf '  Resumed from last snapshot:\n'
  [[ -n "$snap_fnums" && "$snap_fnums" != "null" ]] && printf '    in-progress: %s\n' "$snap_fnums"
  [[ -n "$snap_notes" ]] && printf '    notes: %s\n' "$snap_notes"
fi

printf '\n  Tools available via projects MCP. /board /pickup /handoff for shortcuts.\n'
printf '</projects:state>\n'

hook_log "session-start: ok session=$session_id buddy=${BUDDY_SESSION_NAME:-} repo=$repo"
exit 0
