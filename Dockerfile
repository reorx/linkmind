# ── Build Stage ──
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile

COPY core/ core/
COPY server/ server/

RUN pnpm --filter @linkmind/core run build
RUN pnpm --filter @linkmind/server run build

# ── Production Stage ──
FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --prod

# Build artifacts
COPY --from=builder /app/core/dist/ core/dist/
COPY --from=builder /app/server/dist/ server/dist/

# Runtime resources (non-TS)
COPY server/sql/ server/sql/
COPY server/migrations/ server/migrations/
COPY server/scripts/ocr server/scripts/ocr

# Playwright
RUN npx --prefix server playwright install --with-deps chromium

ENV NODE_ENV=production
EXPOSE 3456
CMD ["node", "server/dist/index.js"]
