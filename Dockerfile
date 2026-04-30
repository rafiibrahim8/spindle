# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────── builder
# Compiles native modules (better-sqlite3, sharp), builds backend (tsc) and
# frontend (Vite), then produces a self-contained backend deploy directory
# with only its production dependencies via `pnpm deploy --prod`.
FROM node:20-alpine AS builder

# better-sqlite3 + sharp need a toolchain. vips-dev for sharp at build time.
RUN apk add --no-cache python3 make g++ vips-dev pkgconfig

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# Manifests first so dep install caches across source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./
COPY backend/package.json backend/tsconfig.json ./backend/
COPY frontend/package.json frontend/tsconfig.json ./frontend/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Sources
COPY backend ./backend
COPY frontend ./frontend

RUN pnpm --filter backend run build

# VITE_* env vars are read by Vite at build time and baked into the bundle.
# - VITE_DEFAULT_MUSIC_ROOT: in-container mount point used by the sync flow.
# - VITE_IS_INSIDE_DOCKER:  marker so the frontend can short-circuit the
#   sync prompt entirely; the host-side bind mount is what changes between
#   machines, not /music itself.
ENV VITE_DEFAULT_MUSIC_ROOT=/music \
    VITE_IS_INSIDE_DOCKER=1
RUN pnpm --filter frontend run build

# Self-contained backend bundle (only prod deps with native bindings).
RUN pnpm --filter backend deploy --prod /out/backend

# ──────────────────────────────────────────────────────────── runtime
FROM node:20-alpine

# vips runtime only (no -dev / no toolchain) — keeps the image small.
RUN apk add --no-cache vips tini

WORKDIR /app

COPY --from=builder /out/backend/package.json    ./backend/
COPY --from=builder /out/backend/node_modules    ./backend/node_modules
COPY --from=builder /app/backend/dist            ./backend/dist
COPY --from=builder /app/frontend/dist           ./frontend/dist

ENV NODE_ENV=production \
    PORT=1990 \
    DATA_ROOT=/data \
    SPINDLE_FRONTEND_STATIC_DIR=/app/frontend/dist

EXPOSE 1990
VOLUME ["/data", "/music"]

# tini reaps zombies and forwards signals so docker stop is graceful.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/backend/dist/index.js"]
