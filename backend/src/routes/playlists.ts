import { getDb } from '../db/init.ts';
import { created, fail, json, noContent } from '../http/respond.ts';
import { readJson } from '../http/wrap.ts';

export function listPlaylists(): Response {
  const rows = getDb().query(`
      SELECT p.id, p.name, p.created_at, p.read_only, p.smart_key,
             COUNT(pt.track_id) AS track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.read_only DESC, p.name COLLATE NOCASE
    `).all();
  return json({ playlists: rows });
}

export function getPlaylist(req: { params: { id: string } }): Response {
  const id = Number(req.params.id);
  const db = getDb();
  const playlist = db.query('SELECT * FROM playlists WHERE id = ?').get(id);
  if (!playlist) return fail('Playlist not found', 404);

  const tracks = db.query(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM playlist_tracks pt
      JOIN tracks t          ON t.id = pt.track_id
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position
    `).all(id);
  return json({ playlist, tracks });
}

export async function createPlaylist(req: Request): Promise<Response> {
  const body = await readJson(req);
  const name = String(body?.name ?? '').trim();
  if (!name) return fail('name is required', 400);
  try {
    const result = getDb().query('INSERT INTO playlists(name, read_only) VALUES(?, 0)').run(name);
    const id = Number(result.lastInsertRowid);
    return created({ id, name }, `/api/playlists/${id}`);
  } catch (err) {
    // playlists.name is UNIQUE; the constraint text is the response body, as
    // it was before.
    return fail((err as Error).message, 409);
  }
}

export async function addPlaylistTrack(req: Request & { params: { id: string } }): Promise<Response> {
  const playlistId = Number(req.params.id);
  const body = await readJson(req);
  const trackId = Number(body?.trackId);
  if (!trackId) return fail('trackId is required', 400);

  const db = getDb();
  const meta = db.query('SELECT id, read_only FROM playlists WHERE id = ?')
    .get(playlistId) as { id: number; read_only: number } | null;
  if (!meta) return fail('Playlist not found', 404);
  if (meta.read_only) return fail('Cannot modify read-only playlist', 403);

  const trackExists = db.query('SELECT 1 FROM tracks WHERE id = ?').get(trackId);
  if (!trackExists) return fail('Track not found', 404);

  const lastPos = db.query('SELECT MAX(position) AS p FROM playlist_tracks WHERE playlist_id = ?')
    .get(playlistId) as { p: number | null };
  const nextPos = (lastPos.p ?? -1) + 1;

  db.query('INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES(?, ?, ?)')
    .run(playlistId, trackId, nextPos);

  return noContent();
}
