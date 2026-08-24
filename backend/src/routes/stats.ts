import { getDb } from '../db/init.ts';
import { fail, json } from '../http/respond.ts';
import { readJson } from '../http/wrap.ts';
import { markPlayCompleted, recordPlay } from '../services/stats.ts';

export function mostPlayed(req: Request): Response {
  const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 25);
  const rows = getDb().query(`
      SELECT t.*, a.art_path, s.play_count, s.last_played
      FROM play_stats s
      JOIN tracks t       ON t.id = s.track_id
      LEFT JOIN albums a  ON a.id = t.album_id
      WHERE s.play_count > 0
      ORDER BY s.play_count DESC, s.last_played DESC
      LIMIT ?
    `).all(limit);
  return json({ tracks: rows });
}

export function recentlyPlayed(req: Request): Response {
  const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 25);
  const rows = getDb().query(`
      SELECT t.*, a.art_path, s.play_count, s.last_played
      FROM play_stats s
      JOIN tracks t       ON t.id = s.track_id
      LEFT JOIN albums a  ON a.id = t.album_id
      WHERE s.last_played IS NOT NULL
      ORDER BY s.last_played DESC
      LIMIT ?
    `).all(limit);
  return json({ tracks: rows });
}

export function recentlyAdded(req: Request): Response {
  const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 25);
  const rows = getDb().query(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      ORDER BY t.date_added DESC
      LIMIT ?
    `).all(limit);
  return json({ tracks: rows });
}

export async function postPlay(req: Request): Promise<Response> {
  const body = await readJson(req);
  const trackId = Number(body?.trackId);
  if (!trackId) return fail('trackId is required', 400);

  const exists = getDb().query('SELECT 1 FROM tracks WHERE id = ?').get(trackId);
  if (!exists) return fail('Track not found', 404);

  recordPlay(trackId);
  return json({ ok: true });
}

export async function postPlayComplete(req: Request): Promise<Response> {
  const body = await readJson(req);
  const trackId = Number(body?.trackId);
  if (!trackId) return fail('trackId is required', 400);

  markPlayCompleted(trackId);
  return json({ ok: true });
}

function clampLimit(value: unknown, fallback: number): number {
  const n = parseInt(String(value || fallback), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100);
}
