import express from 'express';
import { getDb } from '../db/init.js';

const router = express.Router();

router.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(`
      SELECT ar.id, ar.name,
             COUNT(DISTINCT al.id) AS album_count,
             COUNT(DISTINCT t.id)  AS track_count
      FROM artists ar
      LEFT JOIN albums al ON al.artist_id = ar.id
      LEFT JOIN tracks t  ON t.artist_id  = ar.id
      GROUP BY ar.id
      ORDER BY ar.name COLLATE NOCASE
    `)
    .all();
  res.json({ artists: rows });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare<[number]>('SELECT id, name FROM artists WHERE id = ?')
    .get(id);
  if (!row) {
    res.status(404).json({ error: 'Artist not found' });
    return;
  }
  res.json(row);
});

router.get('/:id/albums', (req, res) => {
  const id = Number(req.params.id);
  const rows = getDb()
    .prepare<[number]>(`
      SELECT a.id, a.title, a.year, a.art_path, COUNT(t.id) AS track_count
      FROM albums a
      LEFT JOIN tracks t ON t.album_id = a.id
      WHERE a.artist_id = ?
      GROUP BY a.id
      ORDER BY a.year DESC, a.title COLLATE NOCASE
    `)
    .all(id);
  res.json({ albums: rows });
});

export default router;
