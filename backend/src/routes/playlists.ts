import express from 'express';
import { getDb } from '../db/init.js';

const router = express.Router();

router.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(`
      SELECT p.id, p.name, p.created_at, p.read_only, p.smart_key,
             COUNT(pt.track_id) AS track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.read_only DESC, p.name COLLATE NOCASE
    `)
    .all();
  res.json({ playlists: rows });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const playlist = getDb()
    .prepare<[number]>('SELECT * FROM playlists WHERE id = ?')
    .get(id) as { id: number } | undefined;
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  const tracks = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM playlist_tracks pt
      JOIN tracks t          ON t.id = pt.track_id
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position
    `)
    .all(id);
  res.json({ playlist, tracks });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const result = getDb()
      .prepare('INSERT INTO playlists(name, read_only) VALUES(?, 0)')
      .run(name);
    res.json({ id: Number(result.lastInsertRowid), name });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.post('/:id/tracks', (req, res) => {
  const playlistId = Number(req.params.id);
  const trackId = Number(req.body?.trackId);
  if (!trackId) {
    res.status(400).json({ error: 'trackId is required' });
    return;
  }
  const db = getDb();
  const meta = db
    .prepare<[number]>('SELECT id, read_only FROM playlists WHERE id = ?')
    .get(playlistId) as { id: number; read_only: number } | undefined;
  if (!meta) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (meta.read_only) {
    res.status(403).json({ error: 'Cannot modify read-only playlist' });
    return;
  }
  const trackExists = db
    .prepare<[number]>('SELECT 1 FROM tracks WHERE id = ?')
    .get(trackId);
  if (!trackExists) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  const lastPos = db
    .prepare<[number]>('SELECT MAX(position) AS p FROM playlist_tracks WHERE playlist_id = ?')
    .get(playlistId) as { p: number | null };
  const nextPos = (lastPos.p ?? -1) + 1;

  db.prepare('INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES(?, ?, ?)')
    .run(playlistId, trackId, nextPos);

  res.json({ ok: true });
});

export default router;
