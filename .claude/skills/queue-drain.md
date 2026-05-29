---
name: queue-drain
description: Toggle / inspect queue-drain mode. When ON, this session auto-claims the next Ready card after every successful handoff_card — no need to flip cards manually.
argument-hint: "on | off | status"
---

# /queue-drain $ARGUMENTS

Queue-drain mode lets a single long-running cc session drain the Ready
column automatically. The server (F035.13) emits a `queue_drain_dispatch`
event after every `cardmem_handoff_card`; the session-side contract
(this skill) reacts by immediately calling `cardmem_pickup_card` on
the next card. Loop until Ready is empty.

## Arguments

| `$ARGUMENTS` | Action |
|---|---|
| `on` (or empty) | Opt this session into queue-drain |
| `off` | Opt out — current in-flight card finishes; no new pickups |
| `status` | Print current mode + last dispatched card |

## Step 1 — `/queue-drain on`

1. Resolve current `session_id` (from SessionStart context, cached under `~/.claude/state/session-id`).
2. Resolve `project_id` of the active project (from `cardmem_session_start` payload).
3. Call `cardmem_update_settings` to set `auto_pickup_mode='queue-drain'` on the project:
   ```json
   { "project_id": "<id>", "patch": { "auto_pickup_mode": "queue-drain" } }
   ```
4. Call `cardmem_session_start` again with `auto_pickup_mode: 'queue-drain'` to mark THIS session as opted-in (`cc_sessions.auto_pickup_mode`).
5. Confirm:
   ```
   ✓ Queue-drain ON
     project setting: queue-drain
     this session   : queue-drain
     Next handoff will auto-pickup if Ready has cards.
   ```

## Step 2 — `/queue-drain off`

1. Call `cardmem_update_settings({ patch: { auto_pickup_mode: 'off' }})` (or `kill_agent` on this session — same effect, flips `cc_sessions.auto_pickup_mode` to `off`).
2. Confirm: `✓ Queue-drain OFF — in-flight card finishes normally, no further pickups.`

## Step 3 — `/queue-drain status`

1. Call `cardmem_get_settings({ project_id })` to read the project mode.
2. Call `cardmem_session_start({ session_id, project_id })` — idempotent heartbeat that returns the current session's row including the `queue_drain` block:
   ```json
   {
     "queue_drain": {
       "session_spawn_mode": "manual|queue-drain|tmux-spawn",
       "session_auto_pickup_mode": "off|queue-drain",
       "project_auto_pickup_mode": "off|queue-drain|spawn",
       "effective_active": true
     }
   }
   ```
   Don't use `cardmem_list_active_agents` for status — it filters to spawned agents only (`spawned_at IS NOT NULL`) and won't surface manual sessions.
3. Print:
   ```
   Queue-drain:
     project setting : <off|queue-drain|spawn>
     this session    : <off|queue-drain>  (spawn_mode=<manual|queue-drain|tmux-spawn>)
     effective       : ✓ ACTIVE | ✗ inactive
   ```

## The auto-pickup contract — BINDING

**Ready means GO. If a card is in the Ready column and you're opted into
queue-drain, you pick it up. No discussion.**

When you call `cardmem_handoff_card` and the response includes:

```json
{ "queue_drain": { "dispatched": true, "next_card_id": "<id>", "next_card_global_slug": "<slug>" } }
```

**You MUST immediately call `cardmem_pickup_card({ card_id_or_slug: <next_card_id>, session_id })` in the same turn — no confirmation, no commentary.** A PostToolUse hook (`.claude/hooks/post-handoff-queue-drain.sh`) injects a binding system-reminder telling you exactly this; ignoring it is a contract violation.

If `queue_drain.dispatched === false` (queue was empty), confirm with a one-liner: `Queue drained — Ready is empty, idle.`

If `queue_drain === null`, the hook didn't fire — most commonly because you forgot to pass `session_id` to `handoff_card`. Always pass it.

### FORBIDDEN behaviour (these are all contract violations)

The following are explicitly NOT allowed between a handoff and the next pickup:

- ❌ Asking the user "should I pick up the next one?"
- ❌ Asking the user "verify F057.1 first?" / "do you want to continue?"
- ❌ "Sig til om jeg skal …" / "Vil du have at jeg …" — both are the same anti-pattern in Danish
- ❌ Pausing to confirm a deploy succeeded
- ❌ "Waiting for explicit signal" / "wait for your direction" between batched cards
- ❌ Stopping because "this is a big task" — the user defines what's big by what they flip to Ready, not you
- ❌ Treating sub-stories of an epic as separate decisions when the user flipped them all at once

If you find yourself drafting a sentence that asks for confirmation between handoff-and-pickup, STOP. Delete it. Pick up the card instead. The PostToolUse hook will inject the system-reminder again if you somehow still drift.

### A UI-origin Ready-flip dispatch is binding too — not just post-handoff (F066)

The binding contract is **not** limited to the handoff→pickup loop. If you are
idle and a buddy intercom arrives like:

```
[queue-drain] BINDING — card <slug> moved <from> → ready (moved by: UI)
```

that `moved by: UI` (or `system`) stamp means **a human flipped the card to
Ready**. In queue-drain mode that IS the go — claim it **immediately**, in the
same turn, no confirmation:

```
cardmem_pickup_card({ card_id_or_slug: '<id>' })
```

Do NOT hedge with "you control pickup" / "waiting for explicit go" / "I'll
observe but not claim". The human flipping to Ready is the explicit go. A
queue-drain session that leaves a UI-flipped Ready card sitting is in
violation of this contract — it is the exact failure F066 exists to prevent.

**Exception — agent-origin flips:** a message reading `moved by: agent` is FYI
only, NOT a pickup trigger (it prevents agent→agent cascades). Only `UI` /
`system` origin is binding.

> If a prior instruction in this session told you to be cautious / not touch a
> card (e.g. during a routing test), that instruction does NOT survive into a
> real UI-origin BINDING dispatch. The contract wins.

### When the cloud-dispatched card is invalid (archived, stale, already-claimed)

The cloud's queue-drain picker has a known bug where it can dispatch an archived/stale card. If `cardmem_pickup_card` on the dispatched id fails (or the get_card response shows `archived: true`), the fallback is:

1. Call `cardmem_list_cards({ project_id, column: 'ready' })` to get the real Ready column
2. Pick up the first non-archived card in the list
3. STILL do not ask the user — falling back to the next valid card is the same contract, not a new decision

The user's intent ("drain the queue") covers all valid Ready cards, regardless of which one the buggy picker happens to point at.

### Why this is binding

The whole point of queue-drain is that the user shouldn't have to micromanage the work-loop. Every "should I continue?" defeats it. Every "let me verify before next" defeats it. The user already verified the workflow when they enabled queue-drain mode; the act of flipping a card to Ready is the verification.

## Always pass session_id

Every call to `cardmem_pickup_card` and `cardmem_handoff_card` MUST include `session_id`. Without it the server can't emit queue-drain events tied to your session, AND the audit log loses the agent attribution. Same source as `/pickup` and `/handoff` skills use.

## How to know if you're in queue-drain mode mid-session

Two signals:
1. `cardmem_session_start` response includes the session's current `auto_pickup_mode` (added in F035.13).
2. Every `handoff_card` response carries a `queue_drain` object — `dispatched: true` means you ARE in queue-drain mode AND a card was dispatched; `dispatched: false` means you're in queue-drain mode but Ready was empty; `null` means queue-drain conditions weren't met (mode off, etc).

## Kill switch

Christian can flip your session off via the F051 Agents tab (Stop button on queue-drain rows). Next `session_start` heartbeat will surface `auto_pickup_mode='off'`. When you see that, stop processing dispatch events; let your current card finish.

Server-wide kill: `PROJECTS_AUTO_DISPATCH=off` env disables the entire post-handoff hook — no events emitted regardless of session/project setting.

## Why this skill matters

Without queue-drain, finishing a card means cc goes idle until Christian manually flips the next card to Ready. With queue-drain on, Christian just keeps loading the queue and the session works its way through. It's the difference between "serial assistant" and "actually-autonomous worker on a defined backlog".
