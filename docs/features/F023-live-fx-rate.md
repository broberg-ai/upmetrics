# F023 — Live USD→DKK FX rate (rolling-5 fallback)

> **Goal:** Replace the static `usdToDkk = 6.9` with a LIVE rate from a free,
> no-key FX API, single-sourced so `/api/cost/summary` (`usd_to_dkk`) and the
> credits `/balance` (`remaining_dkk`) always show a correct DKK companion.
> Resilient by design: if the API is unreachable, fall back to the average of the
> last ≤5 stored rates; if none are stored yet, the config default.
>
> Christian-requested 2026-06-28. The static 6.9 had drifted ~5% (live ≈ 6.55).

## Source

`GET https://open.er-api.com/v6/latest/USD` — free, **no API key**, daily-updated
(`rates.DKK`). Verified live (6.55). `fetch` follows redirects by default.

## Design

- **`fx_rates` table** (bun:sqlite + Drizzle): append-only, but **pruned to the
  last 5 rows per pair** on each insert — a continuous roll, never more than 5.
  Persisted so the fallback survives a restart.
- **`refreshFxRate()`** — fetch the live rate; on success store it (roll-to-5) +
  set the in-memory `current`; on ANY failure set `current` = average of the last
  ≤5 stored, or the config default if none. Never throws into the request path.
- **`usdToDkk()`** — a SYNC getter returning the cached `current` rate, so request
  handlers (`/api/cost/summary`, credits `/balance`) stay sync + fast. No
  per-request network call.
- **Refresh cadence** — on boot + every `FX_REFRESH_INTERVAL_MS` (default 12h; the
  source is daily, so finer adds nothing). A background worker, like correlation/
  retention.
- **Single source** — every DKK conversion reads `usdToDkk()`; the literal 6.9
  remains only as the last-resort config default (`USD_TO_DKK`).

## Non-goals

Real-time / sub-daily FX; currencies beyond USD→DKK; paid feeds; a second API
(one source + the rolling-5 fallback is the resilience, per the request).

## Stories

- **F023.1** — fx_rates model + live fetch + rolling-5 + fallback + refresh worker,
  wired into the cost-API + credits export (replace the static rate).
