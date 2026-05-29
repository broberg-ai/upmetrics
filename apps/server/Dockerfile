# @upmetrics/server — Bun runtime image for fly.io.
FROM oven/bun:1-slim
WORKDIR /app

# Install deps first (layer cache). apps/server is self-contained (no workspace
# imports at runtime yet), so a standalone install keeps the image simple.
COPY package.json ./
RUN bun install

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Apply Drizzle domain migrations + Better Auth tables, then serve.
CMD ["sh", "-c", "bun run src/db/migrate.ts && bun run src/auth/migrate-auth.ts && bun run src/index.ts"]
