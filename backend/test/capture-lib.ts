/**
 * Replay the contract spec against a running server and record the results.
 *
 * The CLI wrapper is capture.ts; contract.test.ts drives captureAll() directly.
 *
 * Runs under Bun in both directions: it is an HTTP client, so the server on the
 * other end can be the old Express app (Node) or the Bun rewrite.
 *
 * Recording rules, chosen so the diff catches real regressions and not noise:
 *  - Volatile JSON fields (server-clock timestamps, uuids) become placeholders.
 *  - Only contract-bearing headers are kept; `date` and friends are dropped.
 *  - Image bodies record *decoded dimensions*, not bytes: `/art?w=64` must stay
 *    64px wide, but sharp and Bun.Image are different encoders and will never
 *    produce identical bytes. Audio bodies record a digest, because those are
 *    file bytes and must match exactly.
 *  - Long arrays are summarised as {length, sha256, head}. A full capture of
 *    this library is 2.5 MB, which is unreviewable as a committed diff; the
 *    digest still covers every element, so a change anywhere is still caught,
 *    and `head` usually shows what moved. Set FULL=1 to keep whole arrays when
 *    a digest mismatch needs investigating.
 */
import { buildSpec, resolveBody, type State, type Step } from './spec.ts';

/** Arrays longer than this are digested rather than stored element by element. */
const ARRAY_HEAD = 5;
const FULL_ARRAYS = process.env.FULL === '1';

/** Server-clock values: present-or-absent is the contract, not the number. */
const VOLATILE_KEYS = new Set(['liked_at', 'likedAt', 'last_played', 'lastPlayed', 'jobId', 'created_at', 'createdAt']);

/** Headers that carry contract meaning. Everything else is transport noise. */
const KEEP_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'cache-control', 'etag', 'last-modified', 'vary',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-credentials'
];

/**
 * Art *images* are re-encoded by a different library, so their validators
 * cannot match. Error responses under /art are ordinary JSON and are compared
 * normally — masking those would hide a missing header behind a placeholder.
 */
const MASK_VALIDATORS = (name: string, contentType: string) =>
  name.startsWith('art:') && contentType.startsWith('image/');

/**
 * `Last-Modified` on the SPA files is the mtime of whichever stub the capture
 * ran against, which is created fresh by each harness and is not part of the
 * API contract. Presence is asserted; the value is not.
 */
const MASK_LAST_MODIFIED = (name: string) => name.startsWith('spa:');

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalizeJson);
    if (FULL_ARRAYS || items.length <= ARRAY_HEAD) return items;
    return {
      __array: {
        length: items.length,
        sha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(items)).digest('hex'),
        head: items.slice(0, ARRAY_HEAD)
      }
    };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = VOLATILE_KEYS.has(k) ? (v === null ? null : '<VOLATILE>') : normalizeJson(v);
    }
    return out;
  }
  return value;
}

function pickHeaders(res: Response, step: Step): Record<string, string> {
  const contentType = res.headers.get('content-type') ?? '';
  const mask = MASK_VALIDATORS(step.name, contentType);
  const out: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v === null) continue;
    const masked = (mask && (h === 'etag' || h === 'last-modified'))
      || (h === 'last-modified' && MASK_LAST_MODIFIED(step.name));
    out[h] = masked ? '<PRESENT>' : v;
  }
  return out;
}

async function discover(BASE: string): Promise<State> {
  const j = async (p: string) => (await fetch(`${BASE}${p}`)).json() as Promise<any>;

  // Deterministic picks: the spec must resolve to the same rows on every run.
  const tracks = await j('/api/tracks?sort=title&order=asc&limit=1');
  const albums = await j('/api/albums');
  const artists = await j('/api/artists');
  const playlists = await j('/api/playlists');

  const track = tracks.tracks[0];
  const smart = playlists.playlists.find((p: any) => p.read_only === 1 || p.readOnly === 1);

  // A genre that actually has rows, found by walking a page of tracks.
  const page = await j('/api/tracks?limit=200');
  const genre = page.tracks.map((t: any) => t.genre).find((g: any) => typeof g === 'string' && g.length > 0) ?? 'Rock';

  // An art file the cache already holds.
  const withArt = page.tracks.find((t: any) => typeof t.art_path === 'string' && t.art_path.startsWith('/art/'));
  const artFile = withArt ? String(withArt.art_path).replace('/art/', '') : '';

  if (!track || !albums.albums[0] || !artists.artists[0] || !smart || !artFile) {
    throw new Error('discovery failed — database does not have the rows the spec needs');
  }
  return {
    trackId: track.id,
    albumId: albums.albums[0].id,
    artistId: artists.artists[0].id,
    smartPlaylistId: smart.id,
    genre,
    artFile
  };
}

export interface Record_ {
  name: string;
  request: { method: string; path: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  binary?: { bytes: number; sha256?: string; image?: { width: number; height: number; format: string } };
  text?: string;
}

export interface Capture { discovered: State; records: Record_[] }

export async function captureAll(BASE: string): Promise<Capture> {
  const state = await discover(BASE);
  const records: Record_[] = [];
  for (const step of buildSpec()) {
    const path = typeof step.path === 'function' ? step.path(state) : step.path;
    const headers = typeof step.headers === 'function' ? step.headers(state) : (step.headers ?? {});
    const method = step.method ?? 'GET';
    const body = resolveBody(step, state);
  
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
  
    const rec: Record_ = {
      name: step.name,
      request: { method, path, ...(body === undefined ? {} : { body }) },
      status: res.status,
      headers: pickHeaders(res, step)
    };
  
    const ctype = res.headers.get('content-type') ?? '';
    if (step.kind === 'binary') {
      const buf = new Uint8Array(await res.arrayBuffer());
      rec.binary = { bytes: buf.length };
      if (ctype.startsWith('image/') && buf.length > 0) {
        try {
          const md = await new Bun.Image(buf).metadata();
          rec.binary.image = { width: md.width, height: md.height, format: md.format };
        } catch { /* not a decodable image; bytes alone will have to do */ }
      } else if (buf.length > 0) {
        // Audio and error bodies: exact bytes are the contract.
        rec.binary.sha256 = new Bun.CryptoHasher('sha256').update(buf).digest('hex');
      }
      if (ctype.includes('application/json') && buf.length > 0) {
        rec.json = normalizeJson(JSON.parse(new TextDecoder().decode(buf)));
        delete rec.binary.sha256;
      }
    } else if (ctype.includes('application/json')) {
      rec.json = normalizeJson(await res.json());
    } else {
      const t = await res.text();
      rec.text = t.length > 400 ? `${t.slice(0, 400)}…<${t.length} bytes>` : t;
    }
  
    step.capture?.({ status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), json: rec.json }, state);
    records.push(rec);
  }
  return { discovered: state, records };
}
