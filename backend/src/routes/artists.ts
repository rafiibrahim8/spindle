import { getDb } from '../db/init.ts';
import { fail, json } from '../http/respond.ts';

export function listArtists(): Response {
  // Correlated subqueries instead of a double LEFT JOIN: joining albums and
  // tracks together builds an albums×tracks cartesian intermediate per
  // artist before COUNT(DISTINCT) collapses it again.
  const rows = getDb().query(`
      SELECT ar.id, ar.name,
             (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count,
             (SELECT COUNT(*) FROM tracks t  WHERE t.artist_id  = ar.id) AS track_count
      FROM artists ar
      ORDER BY ar.name COLLATE NOCASE
    `).all();
  return json({ artists: rows });
}

export function getArtist(req: { params: { id: string } }): Response {
  const row = getDb().query('SELECT id, name FROM artists WHERE id = ?').get(Number(req.params.id));
  if (!row) return fail('Artist not found', 404);
  return json(row);
}

export function getArtistAlbums(req: { params: { id: string } }): Response {
  const rows = getDb().query(`
      SELECT a.id, a.title, a.year, a.art_path, COUNT(t.id) AS track_count
      FROM albums a
      LEFT JOIN tracks t ON t.album_id = a.id
      WHERE a.artist_id = ?
      GROUP BY a.id
      ORDER BY a.year DESC, a.title COLLATE NOCASE
    `).all(Number(req.params.id));
  return json({ albums: rows });
}
