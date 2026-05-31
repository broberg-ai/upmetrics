# upmetrics-watchdog (F008.2)

External **off-fly** uptime watchdog. A Cloudflare Worker runs on a cron trigger
(every 2 min) and pings `upmetrics.org/health` + `cronjobs.webhouse.net/` from the
edge. When arn/upmetrics is unreachable it posts **one** Discord alert — and,
crucially, it has **zero runtime dependency on fly/arn**, so it still fires when
the whole region (incl. the on-fly dead-man) is down. This is the deliberate
exception to the "everything in arn" rule.

Dedup state (last status) lives in Workers KV, so a sustained outage produces one
alert + a reminder at most every 30 min, not one per cron tick.

## Logic

`src/decide.ts` is pure + unit-tested (`bun test`). The Worker (`src/index.ts`) is
the thin shell: probe → load KV state → `decide()` → post to Discord → save state.
A probe counts the service **up** if the edge answered at all (HTTP < 500); a
throw/timeout/5xx is **down** (distinguishes a real outage from a 404/login page).

## Deploy (one-time, needs Christian's Cloudflare auth)

```bash
cd watchdog
pnpm install            # or npm/bun install
wrangler login          # interactive — opens browser (Christian's CF account)

# 1. Create the KV namespace, paste the printed id into wrangler.jsonc → kv_namespaces[0].id
wrangler kv namespace create WATCHDOG_KV

# 2. Set the Discord webhook secret (reuse the dead-man channel — it lives in
#    cronjobs job_notifications for job BOF2ExRdY3fjfaBsnvqjG; never commit it)
wrangler secret put DISCORD_WEBHOOK

# 3. Ship it
wrangler deploy
```

Verify: `curl https://upmetrics-watchdog.<subdomain>.workers.dev/` runs a check on
demand and returns `{ upmetrics, cronjobs, alert }`. With upmetrics down it returns
`upmetrics:"down"` and (on the first transition) posts the Discord alert.

## Why this supersedes the on-fly dead-man

F004.4's dead-man runs on cronjobs, which is **also** on fly/arn — a full arn
outage takes down both upmetrics and its watchdog. This Worker is the independent
observer that survives that exact failure.
