import { getDb } from '../db/init.ts';
import { fail, json } from '../http/respond.ts';
import { readJson } from '../http/wrap.ts';
import { getLyrics } from '../services/lyrics.ts';

/** Whitelist: the sort key reaches the SQL directly, so it can never be caller-supplied. */
const SORTS: Record<string, string> = {
  title: 't.title',
  artist: 't.artist',
  album: 't.album',
  date_added: 't.date_added',
  duration: 't.duration',
  play_count: 'COALESCE(s.play_count, 0)',
  liked_at: 't.liked_at'
};

export function listTracks(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const search = (q.get('search') ?? '').trim();
  const artist = (q.get('artist') ?? '').trim();
  const artistId = q.get('artist_id') ? Number(q.get('artist_id')) : null;
  const album = (q.get('album') ?? '').trim();
  const albumId = q.get('album_id') ? Number(q.get('album_id')) : null;
  const genre = (q.get('genre') ?? '').trim();
  const liked = q.get('liked') === '1' || q.get('liked') === 'true';
  const sortKey = SORTS[q.get('sort') ?? 'title'] || SORTS.title;
  const order = (q.get('order') ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = clamp(parseInt(q.get('limit') ?? '500', 10), 1, 5000);
  const offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);

  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (search) {
    where.push('(t.title LIKE @q OR t.artist LIKE @q OR t.album LIKE @q)');
    params.q = `%${search}%`;
  }
  if (artist) {
    where.push('t.artist = @artist');
    params.artist = artist;
  }
  if (artistId) {
    where.push('t.artist_id = @artistId');
    params.artistId = artistId;
  }
  if (album) {
    where.push('t.album = @album');
    params.album = album;
  }
  if (albumId) {
    where.push('t.album_id = @albumId');
    params.albumId = albumId;
  }
  if (genre) {
    where.push('t.genre = @genre');
    params.genre = genre;
  }
  if (liked) {
    where.push('t.liked = 1');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();

  const totalRow = db.query(`SELECT COUNT(*) AS n FROM tracks t ${whereSql}`)
    .get(params) as { n: number };

  const rows = db.query(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      ${whereSql}
      ORDER BY ${sortKey} ${order}
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

  return json({ tracks: rows, total: totalRow.n });
}

export function getTrack(req: { params: { id: string } }): Response {
  const row = getDb().query(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE t.id = ?
    `).get(Number(req.params.id));
  if (!row) return fail('Track not found', 404);
  return json(row);
}

export function getTrackLyrics(req: { params: { id: string } }): Response {
  const id = Number(req.params.id);
  const lyrics = getLyrics(getDb(), id);
  return json({
    trackId: id,
    syncedLrc: lyrics?.syncedLrc ?? null,
    unsyncedText: lyrics?.unsyncedText ?? null
  });
}

export async function setTrackLiked(req: Request & { params: { id: string } }): Promise<Response> {
  const id = Number(req.params.id);
  const body = await readJson(req);
  const liked = Boolean(body?.liked);
  const db = getDb();
  const exists = db.query('SELECT id FROM tracks WHERE id = ?').get(id) as { id: number } | null;
  if (!exists) return fail('Track not found', 404);

  db.query('UPDATE tracks SET liked = ?, liked_at = ? WHERE id = ?')
    .run(liked ? 1 : 0, liked ? Date.now() : null, id);
  return json({ id, liked });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
