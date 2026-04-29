import express from 'express';
import { getDb } from '../db/init.js';

const router = express.Router();

router.get('/', (req, res) => {
  const artistId = req.query.artist_id ? Number(req.query.artist_id) : null;
  const where = artistId ? 'WHERE a.artist_id = ?' : '';
  const params = artistId ? [artistId] : [];
  const rows = getDb()
    .prepare(`
      SELECT a.id, a.title, a.artist_id, a.year, a.genre, a.art_path,
             ar.name AS artist,
             COUNT(t.id) AS track_count
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      LEFT JOIN tracks  t  ON t.album_id = a.id
      ${where}
      GROUP BY a.id
      ORDER BY a.title COLLATE NOCASE
    `)
    .all(...params);
  res.json({ albums: rows });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare<[number]>(`
      SELECT a.*, ar.name AS artist
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?
    `)
    .get(id);
  if (!row) {
    res.status(404).json({ error: 'Album not found' });
    return;
  }
  res.json(row);
});

router.get('/:id/tracks', (req, res) => {
  const id = Number(req.params.id);
  const rows = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE t.album_id = ?
      ORDER BY COALESCE(t.disc_number, 1), COALESCE(t.track_number, 9999), t.title
    `)
    .all(id);
  res.json({ tracks: rows });
});

export default router;
