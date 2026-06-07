# F018 — Dynamic duration format (min/sec) on the Agents view

> Tier: low · Status: in progress · Owner: upmetrics web

## Motivation

Christian (inbox capture + screenshot IMG_8506): "Når der bliver registreret
rigtigt mange sekunder som på en af disse agenter kan du så ikke lave en dynamisk
omregning til minutter og sek." The Agents view's duration formatter showed every
duration ≥1s as `X.Xs` — so a long run reads as "125.0s" or "3661.0s", which is
hard to parse at a glance.

## Solution

One helper change in `apps/web/src/routes/Agents.tsx` — the `ms()` formatter used
by every duration cell (avg/p95/max, per-agent avg, run duration, session list):

- `< 1000ms` → `Xms`
- `< 60s` → `X.Xs` (unchanged)
- `< 60m` → `Xm Ys` (e.g. 125000ms → "2m 5s")
- `≥ 60m` → `Xh Ym` (e.g. 3661000ms → "1h 1m")

## Scope

### In scope
- The adaptive `ms()` formatter + its existing call-sites (no new ones).

### Non-goals
- No new UI/interactive elements (pure display formatting → no data-testid needed).
- No server change (durations are already `duration_ms` integers).
- Not moved to lib/format.ts — `ms()` is only used on the Agents view (surgical).

## Acceptance criteria
1. `ms()` renders `Xm Ys` for sub-hour durations ≥60s and `Xh Ym` beyond an hour;
   sub-minute keeps `X.Xs`, sub-second keeps `Xms`.
2. web typecheck clean; deployed; Lens-verified the Agents view renders.

## Rollout
Single web commit → deploy → Lens-verify the Agents duration cells.
