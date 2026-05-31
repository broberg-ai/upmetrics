
## DECISION (2026-05-31): pull, not push — Buddy is local

Buddy runs **locally** (Christian's Mac, reachable only over Tailscale), never in
cloud. upmetrics is on Fly (public). So upmetrics **cannot push** to Buddy — model
B (pull) is the only clean topology AND it reuses Buddy's existing F47 S2
auto-delegation orchestrator (which already polls for work + ask_peer's the
responsible session via discoverChannels).

**Contract (upmetrics exposes; Buddy's local poll-loop consumes, outbound):**
- `GET /api/remediation/pending` — Bearer `REMEDIATION_RELAY_TOKEN`. Returns
  remediation-eligible incidents (opted-in project, error-kind, severity≥threshold,
  not yet claimed): `{ incident_id, project, repo, issue:{title,culprit,level,
  release,top_stack_frames,occurrences,dashboard_url}, severity, opened_at }`.
- `POST /api/remediation/:incident_id/claim` — Bearer. Body `{ session, note? }`.
  Marks the incident relayed (dedup → drops out of the feed) + records target session.
- Regression-reopen (error recurs in a newer release) re-surfaces the incident in
  the feed automatically.

This supersedes the earlier push-leaning sketch. F010.1 = the feed; F010.2 = repo
map + per-project opt-in; F010.3 = claim dedup + storm-control + regression + records.
