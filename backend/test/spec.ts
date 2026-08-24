/**
 * The API contract, as a replayable list of requests.
 *
 * The same spec runs against the old Express server (to produce the committed
 * baseline in fixtures/) and against the Bun rewrite (in contract.test.ts).
 * Anything the two disagree on is a regression, so this file is the single
 * definition of "the API did not change".
 *
 * Steps run in order and share a mutable `State`: later steps need ids and
 * validators produced by earlier ones (a created playlist, a stream's ETag),
 * and the mutating steps are sequenced so their effects are deterministic
 * against a pristine database copy.
 */

/** Values discovered from the live database before the spec runs. */
export interface Ctx {
  trackId: number;
  albumId: number;
  artistId: number;
  /** A read-only smart playlist — used to assert the 403 on mutation. */
  smartPlaylistId: number;
  /** A genre string that actually exists, so the filter returns rows. */
  genre: string;
  /** An art filename (content hash) present in the cache. */
  artFile: string;
}

/** Carried between steps: things only knowable mid-run. */
export interface State extends Ctx {
  createdPlaylistId?: number;
  streamEtag?: string;
}

export interface Step {
  name: string;
  method?: string;
  path: string | ((s: State) => string);
  body?: unknown;
  headers?: Record<string, string> | ((s: State) => Record<string, string>);
  /** `binary` records a length + digest instead of a parsed body. */
  kind?: 'json' | 'binary';
  /** Stash values later steps depend on. */
  capture?: (ctx: { status: number; headers: Record<string, string>; json: unknown }, s: State) => void;
}

const J = { 'Content-Type': 'application/json' };
const ORIGIN = 'http://localhost:5174';

export function buildSpec(): Step[] {
  return [
    // ── reads: tracks ────────────────────────────────────────────────────
    { name: 'tracks:default',        path: '/api/tracks' },
    { name: 'tracks:limit5',         path: '/api/tracks?limit=5' },
    { name: 'tracks:search',         path: '/api/tracks?search=love&limit=5' },
    { name: 'tracks:sort-artist-desc', path: '/api/tracks?sort=artist&order=desc&limit=5' },
    { name: 'tracks:sort-playcount', path: '/api/tracks?sort=play_count&order=desc&limit=5' },
    { name: 'tracks:sort-liked-at',  path: '/api/tracks?sort=liked_at&order=desc&limit=5' },
    { name: 'tracks:sort-unknown',   path: '/api/tracks?sort=nonsense&limit=2' },
    { name: 'tracks:order-unknown',  path: '/api/tracks?order=sideways&limit=2' },
    { name: 'tracks:by-album-id',    path: (s) => `/api/tracks?album_id=${s.albumId}` },
    { name: 'tracks:by-artist-id',   path: (s) => `/api/tracks?artist_id=${s.artistId}` },
    { name: 'tracks:by-genre',       path: (s) => `/api/tracks?genre=${encodeURIComponent(s.genre)}&limit=5` },
    { name: 'tracks:liked-flag',     path: '/api/tracks?liked=1&limit=5' },
    { name: 'tracks:liked-true',     path: '/api/tracks?liked=true&limit=5' },
    { name: 'tracks:offset',         path: '/api/tracks?limit=3&offset=3' },
    { name: 'tracks:limit-clamp-high', path: '/api/tracks?limit=99999' },
    { name: 'tracks:limit-zero',     path: '/api/tracks?limit=0' },
    { name: 'tracks:limit-invalid',  path: '/api/tracks?limit=abc' },
    { name: 'tracks:offset-negative', path: '/api/tracks?limit=2&offset=-5' },
    { name: 'track:one',             path: (s) => `/api/tracks/${s.trackId}` },
    { name: 'track:404',             path: '/api/tracks/99999999' },
    { name: 'track:nan',             path: '/api/tracks/abc' },
    { name: 'track:lyrics',          path: (s) => `/api/tracks/${s.trackId}/lyrics` },
    { name: 'track:lyrics-missing',  path: '/api/tracks/99999999/lyrics' },

    // ── reads: albums / artists / playlists ──────────────────────────────
    { name: 'albums:all',            path: '/api/albums' },
    { name: 'albums:by-artist',      path: (s) => `/api/albums?artist_id=${s.artistId}` },
    { name: 'album:one',             path: (s) => `/api/albums/${s.albumId}` },
    { name: 'album:404',             path: '/api/albums/99999999' },
    { name: 'album:tracks',          path: (s) => `/api/albums/${s.albumId}/tracks` },
    { name: 'artists:all',           path: '/api/artists' },
    { name: 'artist:one',            path: (s) => `/api/artists/${s.artistId}` },
    { name: 'artist:404',            path: '/api/artists/99999999' },
    { name: 'artist:albums',         path: (s) => `/api/artists/${s.artistId}/albums` },
    { name: 'playlists:all',         path: '/api/playlists' },
    { name: 'playlist:smart',        path: (s) => `/api/playlists/${s.smartPlaylistId}` },
    { name: 'playlist:404',          path: '/api/playlists/99999999' },

    // ── reads: stats / settings / sync ───────────────────────────────────
    { name: 'stats:most-played',     path: '/api/stats/most-played' },
    { name: 'stats:most-played-3',   path: '/api/stats/most-played?limit=3' },
    { name: 'stats:most-played-clamp', path: '/api/stats/most-played?limit=9999' },
    { name: 'stats:recently-played', path: '/api/stats/recently-played' },
    { name: 'stats:recently-added',  path: '/api/stats/recently-added?limit=3' },
    { name: 'settings:get',          path: '/api/settings' },
    { name: 'sync:status',           path: '/api/sync/status' },

    // ── not-found shapes ────────────────────────────────────────────────
    { name: 'api:unknown',           path: '/api/nope' },
    { name: 'art:unknown',           path: '/art/deadbeef.webp', kind: 'binary' },

    // ── CORS ────────────────────────────────────────────────────────────
    { name: 'cors:get-with-origin',  path: '/api/tracks?limit=1', headers: { Origin: ORIGIN } },
    { name: 'cors:preflight',        method: 'OPTIONS', path: '/api/tracks',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' } },

    // ── mutations: like ─────────────────────────────────────────────────
    { name: 'like:set-true',  method: 'PUT', path: (s) => `/api/tracks/${s.trackId}/like`, body: { liked: true },  headers: J },
    { name: 'like:read-back', path: (s) => `/api/tracks/${s.trackId}` },
    { name: 'like:in-list',   path: '/api/tracks?liked=1&limit=5' },
    { name: 'like:set-false', method: 'PUT', path: (s) => `/api/tracks/${s.trackId}/like`, body: { liked: false }, headers: J },
    { name: 'like:coerce',    method: 'PUT', path: (s) => `/api/tracks/${s.trackId}/like`, body: { liked: 'yes' },  headers: J },
    { name: 'like:no-body',   method: 'PUT', path: (s) => `/api/tracks/${s.trackId}/like`, body: {},                headers: J },
    { name: 'like:404',       method: 'PUT', path: '/api/tracks/99999999/like', body: { liked: true }, headers: J },

    // ── mutations: settings ─────────────────────────────────────────────
    { name: 'settings:put', method: 'PUT', path: '/api/settings', headers: J,
      body: { accent: '#FF0000', equalizerPreset: 'Rock', equalizer: [1, 2, 3, 4, 5], visualizer: true } },
    { name: 'settings:put-clamped', method: 'PUT', path: '/api/settings', headers: J,
      body: { equalizer: [99, -99, 0, 0, 0] } },
    { name: 'settings:put-invalid', method: 'PUT', path: '/api/settings', headers: J,
      body: { accent: 'nope', equalizerPreset: '   ', equalizer: [1, 2], visualizer: 'yes' } },
    { name: 'settings:read-back', path: '/api/settings' },

    // ── mutations: playlists ────────────────────────────────────────────
    { name: 'playlist:create', method: 'POST', path: '/api/playlists', body: { name: 'Contract Test PL' }, headers: J,
      capture: ({ json }, s) => { s.createdPlaylistId = (json as { id?: number })?.id; } },
    { name: 'playlist:create-duplicate', method: 'POST', path: '/api/playlists', body: { name: 'Contract Test PL' }, headers: J },
    { name: 'playlist:create-blank', method: 'POST', path: '/api/playlists', body: { name: '   ' }, headers: J },
    { name: 'playlist:add-track', method: 'POST', path: (s) => `/api/playlists/${s.createdPlaylistId}/tracks`,
      body: undefined, headers: J, },
    { name: 'playlist:add-track-again', method: 'POST', path: (s) => `/api/playlists/${s.createdPlaylistId}/tracks`,
      body: undefined, headers: J },
    { name: 'playlist:add-no-trackid', method: 'POST', path: (s) => `/api/playlists/${s.createdPlaylistId}/tracks`,
      body: {}, headers: J },
    { name: 'playlist:add-bad-trackid', method: 'POST', path: (s) => `/api/playlists/${s.createdPlaylistId}/tracks`,
      body: { trackId: 99999999 }, headers: J },
    { name: 'playlist:add-to-readonly', method: 'POST', path: (s) => `/api/playlists/${s.smartPlaylistId}/tracks`,
      body: undefined, headers: J },
    { name: 'playlist:add-to-missing', method: 'POST', path: '/api/playlists/99999999/tracks',
      body: undefined, headers: J },
    { name: 'playlist:read-back', path: (s) => `/api/playlists/${s.createdPlaylistId}` },
    { name: 'playlists:after-create', path: '/api/playlists' },

    // ── mutations: play stats ───────────────────────────────────────────
    { name: 'stats:play',          method: 'POST', path: '/api/stats/play', body: undefined, headers: J },
    { name: 'stats:play-complete', method: 'POST', path: '/api/stats/play/complete', body: undefined, headers: J },
    { name: 'stats:play-no-id',    method: 'POST', path: '/api/stats/play', body: {}, headers: J },
    { name: 'stats:play-404',      method: 'POST', path: '/api/stats/play', body: { trackId: 99999999 }, headers: J },
    { name: 'stats:complete-no-id', method: 'POST', path: '/api/stats/play/complete', body: {}, headers: J },
    { name: 'stats:play-read-back', path: (s) => `/api/tracks/${s.trackId}` },
    { name: 'stats:most-played-after', path: '/api/stats/most-played?limit=3' },

    // ── sync validation (never starts a real sync) ───────────────────────
    { name: 'sync:start-no-root',  method: 'POST', path: '/api/sync/start', body: {}, headers: J },
    { name: 'sync:start-blank',    method: 'POST', path: '/api/sync/start', body: { musicRoot: '   ' }, headers: J },
    { name: 'sync:start-bad-dir',  method: 'POST', path: '/api/sync/start', body: { musicRoot: '/nonexistent/xyz' }, headers: J },
    { name: 'sync:start-file-not-dir', method: 'POST', path: '/api/sync/start', body: { musicRoot: '/etc/hostname' }, headers: J },
    { name: 'sync:progress-unknown', path: '/api/sync/progress/not-a-real-job' },

    // ── streaming: the header/status matrix ─────────────────────────────
    { name: 'stream:full', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary',
      capture: ({ headers }, s) => { s.streamEtag = headers.etag; } },
    { name: 'stream:range',      path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=0-99' } },
    { name: 'stream:range-mid',  path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=1000-1099' } },
    { name: 'stream:suffix',     path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=-100' } },
    { name: 'stream:open-ended', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=1000-' } },
    { name: 'stream:open-ended-tail', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=6846000-' } },
    { name: 'stream:unsatisfiable', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=99999999999-' } },
    { name: 'stream:malformed-range', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=-' } },
    { name: 'stream:multi-range', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary', headers: { Range: 'bytes=0-99,200-299' } },
    { name: 'stream:if-none-match', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary',
      headers: (s) => ({ 'If-None-Match': s.streamEtag ?? '"x"' }) },
    { name: 'stream:if-range-match', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary',
      headers: (s) => ({ 'If-Range': s.streamEtag ?? '"x"', Range: 'bytes=0-99' }) },
    { name: 'stream:if-range-stale', path: (s) => `/api/stream/${s.trackId}`, kind: 'binary',
      headers: { 'If-Range': '"stale-validator"', Range: 'bytes=0-99' } },
    { name: 'stream:404', path: '/api/stream/99999999', kind: 'binary' },

    // ── art: cache headers + ?w= renditions ─────────────────────────────
    { name: 'art:full',   path: (s) => `/art/${s.artFile}`, kind: 'binary' },
    { name: 'art:w64',    path: (s) => `/art/${s.artFile}?w=64`, kind: 'binary' },
    { name: 'art:w128',   path: (s) => `/art/${s.artFile}?w=128`, kind: 'binary' },
    { name: 'art:w256',   path: (s) => `/art/${s.artFile}?w=256`, kind: 'binary' },
    { name: 'art:w-unlisted', path: (s) => `/art/${s.artFile}?w=999`, kind: 'binary' },
    { name: 'art:w-invalid',  path: (s) => `/art/${s.artFile}?w=abc`, kind: 'binary' },
    { name: 'art:traversal',  path: '/art/..%2Fdb%2Fmusic.db', kind: 'binary' },

    // ── SPA: served from the same process in production ─────────────────
    // Registered only when SPINDLE_FRONTEND_STATIC_DIR is set, which also
    // turns unknown /api and /art paths into JSON 404s instead of Express's
    // HTML default. The shipped image always sets it.
    { name: 'spa:root',          path: '/' },
    { name: 'spa:deep-route',    path: '/albums' },
    { name: 'spa:nested-route',  path: '/artists/12/albums' },
    { name: 'spa:hashed-asset',  path: '/assets/app-abc123.js' },
    { name: 'spa:missing-asset', path: '/assets/nope-does-not-exist.js' },
    { name: 'spa:favicon',       path: '/favicon.svg', kind: 'binary' }
  ];
}

/** Steps whose body is filled in from discovered ids at run time. */
export function resolveBody(step: Step, s: State): unknown {
  if (step.body !== undefined) return step.body;
  switch (step.name) {
    case 'playlist:add-track':
    case 'playlist:add-track-again':
    case 'playlist:add-to-readonly':
    case 'playlist:add-to-missing':
      return { trackId: s.trackId };
    case 'stats:play':
    case 'stats:play-complete':
      return { trackId: s.trackId };
    default:
      return undefined;
  }
}
