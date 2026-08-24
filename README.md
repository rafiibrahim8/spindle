# Spindle — Self-Hosted Music Player

A self-hosted, full-stack music player. Bun backend, SolidJS frontend, Bun workspace monorepo.

The brand mark is the spindle of a turntable — concentric grooves around a centered pin.

## Quickstart

```bash
# 1. Install deps
bun install

# 2. Configure (optional)
cp .env.example .env
# Edit .env and set DEFAULT_MUSIC_ROOT to your music directory if you'd like.

# 3. Run dev (backend on :3001, frontend on :5174 with proxy)
bun run dev
```

Then open http://localhost:5174, click **Sync** in the sidebar, and point it at your music root.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start backend + frontend in parallel |
| `bun run dev:backend` | Backend only (`bun --watch`) |
| `bun run dev:frontend` | Frontend only (Vite) |
| `bun run build` | Build both packages |
| `bun run typecheck` | TypeScript across both packages |
| `bun test` | Backend tests |

## Layout

```
backend/   Bun.serve API + bun:sqlite + scanner/sync engine
frontend/  SolidJS SPA — Solid Router, Solid Query, Solid Virtual
```

## Requirements

- Bun 1.4+

No native modules and no compiler toolchain: SQLite, image processing, globbing,
HTTP serving and `.env` loading are all Bun built-ins. The only runtime
dependency is `music-metadata`, which is pure JavaScript and gets bundled into
the build output — the production image ships a single JS file and no
`node_modules`.

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
