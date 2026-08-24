# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────── builder
# Bundles the backend to a single JS file and builds the frontend. Both run
# under Bun, so this stage needs no Node and no compiler toolchain: nothing in
# the dependency tree is a native module.
FROM oven/bun:1.4.0-alpine AS builder

WORKDIR /app

# Manifests first so dependency install caches across source changes.
COPY package.json bun.lock tsconfig.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY backend ./backend
COPY frontend ./frontend

# One bundled file. schema.sql and the migrations are imported as text, so they
# are inlined rather than copied alongside, and music-metadata — the only
# runtime dependency — is bundled in as well, so the runtime stage needs no
# node_modules at all.
RUN cd backend && bun run build

# VITE_* env vars are read by Vite at build time and baked into the bundle.
# - VITE_DEFAULT_MUSIC_ROOT: in-container mount point used by the sync flow.
# - VITE_IS_INSIDE_DOCKER:  marker so the frontend can short-circuit the sync
#   prompt entirely; the host-side bind mount is what changes between
#   machines, not /music itself.
ENV VITE_DEFAULT_MUSIC_ROOT=/music \
    VITE_IS_INSIDE_DOCKER=1
RUN cd frontend && bunx --bun vite build

# ──────────────────────────────────────────────────────────── runtime
FROM oven/bun:1.4.0-alpine

WORKDIR /app

COPY --from=builder /app/backend/dist   ./backend/dist
COPY --from=builder /app/frontend/dist  ./frontend/dist

ENV NODE_ENV=production \
    PORT=1990 \
    DATA_ROOT=/data \
    SPINDLE_FRONTEND_STATIC_DIR=/app/frontend/dist

EXPOSE 1990
VOLUME ["/data", "/music"]

# No init process: the server installs SIGTERM/SIGINT handlers and stops
# itself, and it spawns no children to reap. `--no-env-file` keeps a stray
# .env in the image or a bind mount from overriding the configuration above.
CMD ["bun", "--no-env-file", "backend/dist/index.js"]
