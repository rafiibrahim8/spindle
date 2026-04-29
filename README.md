# Spindle — Self-Hosted Music Player

A self-hosted, full-stack music player. Express + better-sqlite3 backend, SolidJS frontend, pnpm workspace monorepo.

The brand mark is the spindle of a turntable — concentric grooves around a centered pin.

## Quickstart

```bash
# 1. Install deps
pnpm install

# 2. Configure (optional)
cp .env.example .env
# Edit .env and set DEFAULT_MUSIC_ROOT to your music directory if you'd like.

# 3. Run dev (backend on :3001, frontend on :5174 with proxy)
pnpm dev
```

Then open http://localhost:5174, click **Sync** in the sidebar, and point it at your music root.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start backend + frontend in parallel |
| `pnpm dev:backend` | Backend only (`tsx watch`) |
| `pnpm dev:frontend` | Frontend only (Vite) |
| `pnpm build` | Build both packages |
| `pnpm typecheck` | TypeScript across both packages |

## Layout

```
backend/   Express API + better-sqlite3 + scanner/sync engine
frontend/  SolidJS SPA — Solid Router, Solid Query, Solid Virtual
```

## Requirements

- Node.js 20+
- pnpm 9+

`better-sqlite3` and `sharp` are native packages — your platform must support node-gyp builds, or pnpm needs to fetch a prebuilt binary for them.

## Persistence model

Three coordinated storage layers:

| Layer | Purpose |
|---|---|
| SQLite `user_settings` | Accent + equalizer (server-authoritative) |
| `localStorage[music-player:playback-session]` | Track / queue / position / shuffle / repeat / volume |
| `localStorage[volume]`, `localStorage[accent]` | Synchronous mirrors so the boot paint never flashes defaults |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `← / →` | Seek ∓5 s |
| `↑ / ↓` | Volume ∓5 % |
| `N / P` | Next / Previous |
| `S` | Toggle shuffle |
| `R` | Cycle repeat |
| `M` | Toggle mute |
| `L` | Toggle lyrics panel |
| `Ctrl/⌘+F` | Focus search |

## License

MIT — see [LICENSE](./LICENSE).
