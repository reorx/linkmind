FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile

# Copy source
COPY core/ core/
COPY server/ server/

# Install Playwright Chromium + deps
RUN npx --prefix server playwright install --with-deps chromium

# Runtime
ENV NODE_ENV=production
EXPOSE 3456

CMD ["pnpm", "--filter", "@linkmind/server", "dev"]
