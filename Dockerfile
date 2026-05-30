# Multi-stage build for upmetrics: build the dashboard SPA (apps/web) and the
# server (apps/server) reproducibly in-image. Build context = repo root.
# Deploy: fly deploy --config apps/server/fly.toml --dockerfile Dockerfile

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

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Apply Drizzle domain migrations + Better Auth tables, then serve.
CMD ["sh", "-c", "bun run src/db/migrate.ts && bun run src/auth/migrate-auth.ts && bun run src/index.ts"]
