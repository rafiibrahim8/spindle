import { getDb } from '../db/init.ts';

/**
 * Record a play: append to history (completed=0), bump play_count and
 * last_played. Called once per track session, after the play threshold.
 */
export function recordPlay(trackId: number): void {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.query('INSERT INTO play_history(track_id, played_at, completed) VALUES(?, ?, 0)')
      .run(trackId, now);

    db.query(`
      INSERT INTO play_stats(track_id, play_count, last_played)
      VALUES(?, 1, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        play_count = play_count + 1,
        last_played = excluded.last_played
    `).run(trackId, now);
  })();
}

/**
 * Mark the most recent play of a track as completed. Doesn't bump play_count
 * (recordPlay already did that at the play-threshold).
 */
export function markPlayCompleted(trackId: number): void {
  getDb().query(`
    UPDATE play_history SET completed = 1
    WHERE id = (
      SELECT id FROM play_history
      WHERE track_id = ?
      ORDER BY played_at DESC
      LIMIT 1
    )
  `).run(trackId);
}
