import type { Database } from 'bun:sqlite';
import { prepared } from '../db/init.ts';

export interface LyricsRow {
  trackId: number;
  syncedLrc: string | null;
  unsyncedText: string | null;
}

export function upsertLyrics(db: Database, row: LyricsRow): void {
  prepared(db, `
    INSERT INTO lyrics(track_id, synced_lrc, unsynced_text)
    VALUES (@trackId, @syncedLrc, @unsyncedText)
    ON CONFLICT(track_id) DO UPDATE SET
      synced_lrc    = excluded.synced_lrc,
      unsynced_text = excluded.unsynced_text
  `).run(row);
}

export function getLyrics(db: Database, trackId: number): LyricsRow | null {
  const row = prepared(db, 'SELECT track_id, synced_lrc, unsynced_text FROM lyrics WHERE track_id = ?')
    .get(trackId) as { track_id: number; synced_lrc: string | null; unsynced_text: string | null } | null;
  if (!row) return null;
  return { trackId: row.track_id, syncedLrc: row.synced_lrc, unsyncedText: row.unsynced_text };
}
