# Multi-stage build for upmetrics: build the dashboard SPA (apps/web) and the
# server (apps/server) reproducibly in-image. Build context = repo root.
# Deploy: fly deploy --config apps/server/fly.toml --dockerfile Dockerfile

# ── Stage 0: pin the Litestream binary (F008.1 durability) ──────────────────
FROM litestream/litestream:0.3.13 AS litestream

# ── Stage 1: build the dashboard SPA → /web/dist ────────────────────────────
FROM oven/bun:1-slim AS web
WORKDIR /web
COPY apps/web/package.json ./
RUN bun install
COPY apps/web/ ./
RUN bun run build

# ── Stage 2: server runtime + the built SPA ─────────────────────────────────
FROM oven/bun:1-slim
WORKDIR /app
COPY apps/server/package.json ./
RUN bun install
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
