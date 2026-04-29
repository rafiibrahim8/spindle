import { exec } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { getDb } from '../db/init.js';
import { getLyrics } from '../services/lyrics.js';

const router = express.Router();

const SORTS: Record<string, string> = {
  title: 't.title',
  artist: 't.artist',
  album: 't.album',
  date_added: 't.date_added',
  duration: 't.duration',
  play_count: 'COALESCE(s.play_count, 0)',
  liked_at: 't.liked_at'
};

router.get('/', (req, res) => {
  const search = String(req.query.search || '').trim();
  const artist = String(req.query.artist || '').trim();
  const artistId = req.query.artist_id ? Number(req.query.artist_id) : null;
  const album = String(req.query.album || '').trim();
  const albumId = req.query.album_id ? Number(req.query.album_id) : null;
  const genre = String(req.query.genre || '').trim();
  const liked = req.query.liked === '1' || req.query.liked === 'true';
  const sortKey = SORTS[String(req.query.sort || 'title')] || SORTS.title;
  const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = clamp(parseInt(String(req.query.limit || '500'), 10), 1, 5000);
  const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10));

  const where: string[] = [];
  const params: Record<string, unknown> = {};

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

  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tracks t ${whereSql}`)
    .get(params) as { n: number };

  const rows = getDb()
    .prepare(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      ${whereSql}
      ORDER BY ${sortKey} ${order}
      LIMIT @limit OFFSET @offset
    `)
    .all({ ...params, limit, offset });

  res.json({ tracks: rows, total: totalRow.n });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE t.id = ?
    `)
    .get(id);
  if (!row) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }
  res.json(row);
});

router.get('/:id/lyrics', (req, res) => {
  const id = Number(req.params.id);
  const lyrics = getLyrics(getDb(), id);
  res.json({
    trackId: id,
    syncedLrc: lyrics?.syncedLrc ?? null,
    unsyncedText: lyrics?.unsyncedText ?? null
  });
});

router.put('/:id/like', (req, res) => {
  const id = Number(req.params.id);
  const liked = Boolean(req.body?.liked);
  const db = getDb();
  const exists = db.prepare<[number]>('SELECT id FROM tracks WHERE id = ?').get(id) as { id: number } | undefined;
  if (!exists) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }
  db.prepare('UPDATE tracks SET liked = ?, liked_at = ? WHERE id = ?')
    .run(liked ? 1 : 0, liked ? Date.now() : null, id);
  res.json({ id, liked });
});

router.post('/:id/reveal', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare<[number]>('SELECT file_path FROM tracks WHERE id = ?')
    .get(id) as { file_path: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }
  const dir = path.dirname(row.file_path);
  const cmd = revealCommand(dir);
  exec(cmd, (err) => {
    if (err) {
      console.warn('[tracks] reveal failed:', err.message);
      res.status(500).json({ error: 'Could not open file browser' });
      return;
    }
    res.json({ ok: true });
  });
});

function revealCommand(dir: string): string {
  const safe = JSON.stringify(dir);
  switch (process.platform) {
    case 'darwin': return `open ${safe}`;
    case 'win32':  return `explorer ${safe}`;
    default:       return `xdg-open ${safe}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export default router;
