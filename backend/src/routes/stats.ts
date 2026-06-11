import express from 'express';
import { getDb } from '../db/init.js';
import { markPlayCompleted, recordPlay } from '../services/stats.js';

const router = express.Router();

router.get('/most-played', (req, res) => {
  const limit = clampLimit(req.query.limit, 25);
  const rows = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, s.play_count, s.last_played
      FROM play_stats s
      JOIN tracks t       ON t.id = s.track_id
      LEFT JOIN albums a  ON a.id = t.album_id
      WHERE s.play_count > 0
      ORDER BY s.play_count DESC, s.last_played DESC
      LIMIT ?
    `)
    .all(limit);
  res.json({ tracks: rows });
});

router.get('/recently-played', (req, res) => {
  const limit = clampLimit(req.query.limit, 25);
  const rows = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, s.play_count, s.last_played
      FROM play_stats s
      JOIN tracks t       ON t.id = s.track_id
      LEFT JOIN albums a  ON a.id = t.album_id
      WHERE s.last_played IS NOT NULL
      ORDER BY s.last_played DESC
      LIMIT ?
    `)
    .all(limit);
  res.json({ tracks: rows });
});

router.get('/recently-added', (req, res) => {
  const limit = clampLimit(req.query.limit, 25);
  const rows = getDb()
    .prepare<[number]>(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      ORDER BY t.date_added DESC
      LIMIT ?
    `)
    .all(limit);
  res.json({ tracks: rows });
});

router.post('/play', (req, res) => {
  const trackId = Number(req.body?.trackId);
  if (!trackId) {
    res.status(400).json({ error: 'trackId is required' });
    return;
  }
  const exists = getDb()
    .prepare<[number]>('SELECT 1 FROM tracks WHERE id = ?')
    .get(trackId);
  if (!exists) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }
  recordPlay(trackId);
  res.json({ ok: true });
});

router.post('/play/complete', (req, res) => {
  const trackId = Number(req.body?.trackId);
  if (!trackId) {
    res.status(400).json({ error: 'trackId is required' });
    return;
  }
  markPlayCompleted(trackId);
  res.json({ ok: true });
});

function clampLimit(value: unknown, fallback: number): number {
  const n = parseInt(String(value || fallback), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100);
}

export default router;
