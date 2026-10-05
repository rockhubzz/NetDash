# syntax=docker/dockerfile:1

# Node 22 LTS, pinned deliberately: node:sqlite needs >=22.5, and staying
# off bleeding-edge Node releases avoids the native-module ABI churn that
# plain better-sqlite3 hit on Node 26 during development of this app.
# Debian (not Alpine) - Alpine's musl libc has a long history of subtle
# Chromium/Playwright compatibility issues; not worth it for a small image
# size win here.

# ---- Stage 1: install deps + build the Next.js app ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: production-only node_modules (no devDependencies) ----
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: runtime image ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules

# Installs the Chromium binary itself plus every OS library it needs to
# render headlessly. `--with-deps` detects the base OS (Debian Bookworm,
# here) and apt-get installs the exact package list Playwright maintains
# for it - more reliable than hand-listing library names, which drift
# between Debian/Ubuntu releases (the libasound2 / libasound2t64 rename
# being a recent example).
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next ./.next
COPY package.json server.js next.config.js ./
COPY lib ./lib

# Mount point for the persistent SQLite db + per-device Chromium profiles -
# see docker-compose.yml's volumes.
RUN mkdir -p /app/data/profiles

EXPOSE 3000
CMD ["node", "server.js"]
