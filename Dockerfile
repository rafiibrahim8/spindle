# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────── builder
# Compiles native modules (better-sqlite3, sharp), builds backend (tsc) and
# frontend (Vite), then produces a self-contained backend deploy directory
# with only its production dependencies via `pnpm deploy --prod`.
FROM node:22-alpine AS builder

# sharp ships its own libvips inside @img/sharp-linuxmusl-*, so there is no
# vips-dev here and no pkgconfig to find one. Left to its own devices sharp
# would notice Alpine's system libvips (8.18.2 on this base), try to build
# against it via node-gyp, fail for want of node-addon-api, and fall back to
# the bundled 8.15.3 anyway — wasted build work and a needless dependency on
# whatever version Alpine happens to ship. Skipping the detection makes the
# outcome the one it reaches regardless, deterministically.
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1

# Kept for better-sqlite3: it has a musl prebuild for every Node ABI this
# image targets, but the toolchain is the difference between a slow build and
# a failed one if that ever stops being true.
RUN apk add --no-cache python3 make g++

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
FROM node:22-alpine

# No vips package: sharp carries its own libvips in node_modules, so the
# system one would only be dead weight.
RUN apk add --no-cache tini

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
