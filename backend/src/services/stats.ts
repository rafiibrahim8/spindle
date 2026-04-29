import { getDb } from '../db/init.js';

export function recordPlay(trackId: number, completed: boolean): void {
  const db = getDb();
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare('INSERT INTO play_history(track_id, played_at, completed) VALUES(?, ?, ?)')
      .run(trackId, now, completed ? 1 : 0);

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
