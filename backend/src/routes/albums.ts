import { getDb } from '../db/init.ts';
import { fail, json } from '../http/respond.ts';

export function listAlbums(req: Request): Response {
  const artistIdParam = new URL(req.url).searchParams.get('artist_id');
  const artistId = artistIdParam ? Number(artistIdParam) : null;
  const where = artistId ? 'WHERE a.artist_id = ?' : '';
  const params = artistId ? [artistId] : [];

  const rows = getDb().query(`
      SELECT a.id, a.title, a.artist_id, a.year, a.genre, a.art_path,
             ar.name AS artist,
             COUNT(t.id) AS track_count
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      LEFT JOIN tracks  t  ON t.album_id = a.id
      ${where}
      GROUP BY a.id
      ORDER BY a.title COLLATE NOCASE
    `).all(...params);
  return json({ albums: rows });
}

export function getAlbum(req: { params: { id: string } }): Response {
  const row = getDb().query(`
      SELECT a.*, ar.name AS artist
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?
    `).get(Number(req.params.id));
  if (!row) return fail('Album not found', 404);
  return json(row);
}

export function getAlbumTracks(req: { params: { id: string } }): Response {
  const rows = getDb().query(`
      SELECT t.*, a.art_path, COALESCE(s.play_count, 0) AS play_count, s.last_played
      FROM tracks t
      LEFT JOIN albums a     ON a.id = t.album_id
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE t.album_id = ?
      ORDER BY COALESCE(t.disc_number, 1), COALESCE(t.track_number, 9999), t.title
    `).all(Number(req.params.id));
  return json({ tracks: rows });
}
