# Multi-stage build for upmetrics: build the dashboard SPA (apps/web) and the
# server (apps/server) reproducibly in-image. Build context = repo root.
# Deploy: fly deploy --config apps/server/fly.toml --dockerfile Dockerfile

# ── Stage 0: pin the Litestream binary (F008.1 durability) ──────────────────
FROM litestream/litestream:0.3.13 AS litestream

# ── Stage 1: build the dashboard SPA → /web/dist ────────────────────────────
FROM oven/bun:1-slim AS web
WORKDIR /web
# The LOCKFILE comes with the manifest, and the install is FROZEN. Without both,
# `bun install` re-resolves every range on every build, so prod silently runs
# dependency versions nobody tested. Measured 2026-09-15: that is how a
# better-auth release added a required column to our login table and a later one
# stopped filling it — the owner could not sign in, and no version we had pinned
# had changed. A frozen install fails LOUDLY when the lockfile and manifest
# disagree, which is the whole point.
COPY apps/web/package.json apps/web/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/web/ ./
RUN bun run build

# ── Stage 2: server runtime + the built SPA ─────────────────────────────────
FROM oven/bun:1-slim
WORKDIR /app
# ca-certificates so Litestream's S3 client can verify Tigris TLS (F008.1).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY apps/server/package.json apps/server/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/server/ ./
# The server serves this at /  (resolved via import.meta.dir → ../web-dist).
COPY --from=web /web/dist ./web-dist
# Litestream binary (F008.1) + entrypoint that handles restore-on-boot + replicate.
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY start.sh /app/start.sh

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# start.sh: optional Litestream restore → migrations → background replicate → serve.
# Replication is a no-op unless LITESTREAM_BUCKET is set (safe default).
CMD ["sh", "/app/start.sh"]
