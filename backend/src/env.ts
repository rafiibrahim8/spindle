/**
 * Configuration, resolved once at startup.
 *
 * Bun loads `.env` from the working directory only — it does not search upward
 * — so a repo-root `.env` never reaches this process when it runs with cwd
 * `backend/`. That matches what `dotenv.config()` did before, and it is why the
 * repo-root `.env` has never actually configured the backend.
 *
 * `DATA_ROOT` therefore anchors on the working directory rather than on this
 * file's location: the bundle lives in `dist/` while the source lives in `src/`,
 * so a path relative to the module would resolve differently in dev and in
 * production. The container sets `DATA_ROOT` explicitly anyway.
 */
import path from 'node:path';

export const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.resolve(process.cwd(), 'data');

export const DB_PATH = path.join(DATA_ROOT, 'db', 'music.db');
export const ART_CACHE_DIR = path.join(DATA_ROOT, 'art');

export const PORT = Number(process.env.PORT) || 3001;
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5174';

/**
 * Where the built SPA lives. Unset in dev — Vite serves the app on its own port
 * and proxies `/api` — and set in production, which also switches unknown
 * `/api/*` and `/art/*` paths from the SPA fallback to a JSON 404.
 */
export const STATIC_DIR = process.env.SPINDLE_FRONTEND_STATIC_DIR || null;
