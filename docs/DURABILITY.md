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

## Restore-drill KØRT 2026-08-25 (indtil da: dokumenteret, aldrig gået)

Indtil denne dato var Litestream-restore beskrevet i denne fil og aldrig
afprøvet. Værre: da vi FAKTISK havde et nedbrud (arn-host væk), reddede vi os
med et Fly volume-snapshot — path B, ikke path A. Litestream-vejen var altså
konfigureret, overvåget, og ubevist. coverletter spurgte direkte, og det er
spørgsmålet der bør stilles til enhver backup.

Kørt på produktionsmaskinen, replika → `/tmp/restored.db` (bevidst IKKE `/data`:
kopien må ikke røre den base den kopierer, og `/data` har en diskvagt der ville
have alarmeret på 777 MB ekstra):

```
litestream restore -o /tmp/restored.db -config /tmp/litestream.yml /data/upmetrics.db
```

| | |
|---|---|
| 777 MB restoret på | **96 sekunder** |
| `PRAGMA integrity_check` | **ok** |
| projects / events | 19 / 19 · 22.989 / 22.989 |
| issues / agent_runs | 99 / 99 · 33.017 / 33.017 |
| probes / probe_results | 13 / 13 · 46.803 / 46.803 |
| deploy_events / incidents | 413 / 413 · 1.168 / 1.168 |
| nyeste event | identisk tidsstempel — **datatab 0 sekunder** |

Nul afvigelse på otte tabeller. Kopien slettet efter kontrollen.

**Begge veje beholdes.** Litestream giver næsten-nul datatab, men forudsætter at
replikaen kan nås. Volume-snapshottet reddede os da hosten var væk. De to fejler
ikke sammen, og det er hele grunden til at have dem begge.

Gentag drillen efter enhver ændring i `start.sh`, i Litestream-versionen eller i
WAL-opsætningen (`wal_autocheckpoint`, ventilen). En backup der ikke er restoret
er en formodning.
