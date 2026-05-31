#!/bin/sh
# F008.1 — container entrypoint with Litestream durability (mirrors the proven
# cardmem pattern). Boot sequence:
#   1. If LITESTREAM_BUCKET is set, generate /tmp/litestream.yml from env.
#   2. Restore /data/upmetrics.db from the replica IF the local DB is missing
#      (-if-replica-exists → safe no-op on a fresh/empty replica). This is the
#      disaster-recovery path: a normal redeploy keeps the volume, so the DB is
#      present and restore is skipped.
#   3. Apply Drizzle domain migrations + Better Auth tables.
#   4. Background `litestream replicate` (sidecar) when configured. The server
#      stays foreground so fly's restart policy reacts to *server* failure, not
#      replication hiccups.
#   5. exec the server.
#
# Litestream env contract (set via `fly storage create upmetrics-litestream`
# which injects AWS_* creds, plus the LITESTREAM_* vars — see docs/DURABILITY.md):
#   LITESTREAM_BUCKET / LITESTREAM_PATH / LITESTREAM_ENDPOINT / LITESTREAM_REGION
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# If LITESTREAM_BUCKET is unset, replication is skipped (safe default — boots
# exactly like the pre-F008.1 image).
set -e

DATABASE_PATH="${DATABASE_PATH:-/data/upmetrics.db}"
mkdir -p "$(dirname "$DATABASE_PATH")"
LITESTREAM_CONFIG=/tmp/litestream.yml

if [ -n "$LITESTREAM_BUCKET" ]; then
  echo "[start] Litestream: bucket=$LITESTREAM_BUCKET path=$LITESTREAM_PATH endpoint=$LITESTREAM_ENDPOINT region=$LITESTREAM_REGION"
  cat > "$LITESTREAM_CONFIG" <<EOF
dbs:
  - path: $DATABASE_PATH
    replicas:
      - type: s3
        bucket: $LITESTREAM_BUCKET
        path: $LITESTREAM_PATH
        endpoint: $LITESTREAM_ENDPOINT
        region: $LITESTREAM_REGION
        sync-interval: 1s
EOF

  if [ ! -f "$DATABASE_PATH" ]; then
    echo "[start] $DATABASE_PATH missing — restoring from replica if present"
    litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$DATABASE_PATH" || {
      echo "[start] restore failed — exiting (refuse to start on a corrupt/empty DB)"
      exit 1
    }
  else
    echo "[start] $DATABASE_PATH present — skipping restore"
  fi
else
  echo "[start] LITESTREAM_BUCKET unset — running without replication (safe default)"
fi

echo "[start] applying migrations"
bun run src/db/migrate.ts
bun run src/auth/migrate-auth.ts

if [ -n "$LITESTREAM_BUCKET" ]; then
  echo "[start] starting Litestream replicate (sidecar)"
  litestream replicate -config "$LITESTREAM_CONFIG" &
  echo "[start] litestream pid=$!"
fi

echo "[start] starting @upmetrics/server on :${PORT:-8080}"
exec bun run src/index.ts
