# Durability & restore runbook (F008.1)

upmetrics stores everything in a single `bun:sqlite` file on a fly volume
(`/data/upmetrics.db`, app `upmetrics`, region `arn`). Two independent backup
layers protect it:

1. **fly volume snapshots** — automatic daily, 5-day retention. Already on:
   `fly volumes snapshots list vol_4y89ne03jj35171r --app upmetrics`
   (verified 2026-05-31: a 17h-old snapshot existed during the arn outage, so
   worst-case loss without Litestream was ≤24h of telemetry).
2. **Litestream → Tigris** — continuous replication (1s sync) to an S3-compatible
   Tigris bucket, so a fresh machine restores with near-zero loss. Mirrors the
   proven cardmem setup. Activated by `start.sh` when `LITESTREAM_BUCKET` is set;
   a no-op otherwise (safe default).

## One-time provisioning (Litestream)

```bash
# 1. Create a Tigris bucket attached to the app — injects AWS_* creds as secrets.
fly storage create --app upmetrics --name upmetrics-litestream

# 2. Set the LITESTREAM_* vars (mirror cardmem). ENDPOINT/REGION come from the
#    Tigris creds printed above (endpoint = https://fly.storage.tigris.dev).
fly secrets set --app upmetrics \
  LITESTREAM_BUCKET=upmetrics-litestream \
  LITESTREAM_PATH=upmetrics \
  LITESTREAM_ENDPOINT=https://fly.storage.tigris.dev \
  LITESTREAM_REGION=auto

# 3. Deploy. On boot start.sh will replicate; restore only triggers on a fresh
#    (empty) volume.
fly deploy --app upmetrics
```

## Restore drill / disaster recovery

**A — from the Litestream replica (preferred, near-zero loss).** A fresh machine
with an empty volume restores automatically on boot (`start.sh` runs
`litestream restore -if-replica-exists`). To force a manual restore locally:

```bash
LITESTREAM_BUCKET=upmetrics-litestream LITESTREAM_PATH=upmetrics \
LITESTREAM_ENDPOINT=https://fly.storage.tigris.dev LITESTREAM_REGION=auto \
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
litestream restore -o ./restored.db -config /tmp/litestream.yml /data/upmetrics.db
```

**B — from a fly volume snapshot (when the volume/host is lost).**

```bash
fly volumes snapshots list vol_4y89ne03jj35171r --app upmetrics   # pick an id
fly volumes create upmetrics_data --app upmetrics --region arn \
  --snapshot-id <vs_…> --size 1
# then attach to a new machine / fly deploy
```

## During an arn host outage (2026-05-31 incident)

A fly *host* (not just the machine) became unreachable — `fly machine restart`
returns 408 and `fly deploy` fails on the unreachable volume. **Do not** force
deploys during the flap (see memory `upmetrics-deploy-during-flap`). Recovery:
wait for fly to restore the host, then `fly machine start`. The external
watchdog (F008.2) alerts from off-fly; storm-control (F008.3) collapses the
fleet noise into one alert.
