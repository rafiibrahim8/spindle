import { getDb } from '../db/init.js';

/**
 * Record a play: append to history (completed=0), bump play_count and
 * last_played. Called once per track session, after the play threshold.
 */
export function recordPlay(trackId: number): void {
  const db = getDb();
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare('INSERT INTO play_history(track_id, played_at, completed) VALUES(?, ?, 0)')
      .run(trackId, now);

    db.prepare(`
      INSERT INTO play_stats(track_id, play_count, last_played)
      VALUES(?, 1, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        play_count = play_count + 1,
        last_played = excluded.last_played
    `).run(trackId, now);
  });
  txn();
}

/**
 * Mark the most recent play of a track as completed. Doesn't bump play_count
 * (recordPlay already did that at the play-threshold).
 */
export function markPlayCompleted(trackId: number): void {
  getDb().prepare(`
    UPDATE play_history SET completed = 1
    WHERE id = (
      SELECT id FROM play_history
      WHERE track_id = ?
      ORDER BY played_at DESC
      LIMIT 1
    )
  `).run(trackId);
}
