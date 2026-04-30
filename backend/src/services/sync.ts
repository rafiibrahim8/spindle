import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { getDb } from '../db/init.js';
import type { SyncEvent, SyncResult, TrackMeta } from '../types.js';
import { extractMetadata, partialHash } from './metadata.js';
import { upsertLyrics } from './lyrics.js';
import { scanDirectory } from './scanner.js';

interface JobRecord {
  id: string;
  emitter: EventEmitter;
  status: 'running' | 'done' | 'error';
  result?: SyncResult;
  error?: string;
  events: SyncEvent[];
}

const jobs = new Map<string, JobRecord>();
let latestRunningJobId: string | null = null;

export function createSyncJob(rootDir: string): string {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const record: JobRecord = { id, emitter, status: 'running', events: [] };
  jobs.set(id, record);
  latestRunningJobId = id;

  // Run async, do not block.
  void runSync(rootDir, record)
    .catch((err) => {
      record.status = 'error';
      record.error = (err as Error).message;
      const event: SyncEvent = { type: 'error', message: record.error };
      record.events.push(event);
      emitter.emit('event', event);
    })
    .finally(() => {
      if (latestRunningJobId === id) latestRunningJobId = null;
    });

  return id;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function getActiveJobId(): string | null {
  if (!latestRunningJobId) return null;
  const job = jobs.get(latestRunningJobId);
  if (!job || job.status !== 'running') {
    latestRunningJobId = null;
    return null;
  }
  return latestRunningJobId;
}

async function runSync(rootDir: string, record: JobRecord): Promise<void> {
  const db = getDb();
  const emit = (event: SyncEvent) => {
    record.events.push(event);
    record.emitter.emit('event', event);
  };

  // Persist music root immediately.
  upsertSetting('music_root', rootDir);

  emit({ type: 'progress', phase: 'scanning', current: 0, total: 0 });

  const files = await scanDirectory(rootDir);
  emit({ type: 'progress', phase: 'scanning', current: files.length, total: files.length });

  // Build the existing index ahead of time. Includes size so we can decide
  // rclone-style: identical-by-stat → cheap hash verify; differing stat → still
  // hash-check before paying the cost of a full metadata parse.
  const existing = new Map<string, { id: number; mtime: number; hash: string; size: number }>();
  const existingRows = db
    .prepare('SELECT id, file_path, file_mtime, file_hash, file_size FROM tracks')
    .all() as Array<{ id: number; file_path: string; file_mtime: number; file_hash: string; file_size: number }>;
  for (const row of existingRows) {
    existing.set(row.file_path, {
      id: row.id,
      mtime: row.file_mtime,
      hash: row.file_hash,
      size: row.file_size
    });
  }

  // Walk filesystem, decide per-file action, extract metadata as needed.
  const onDisk = new Set<string>();
  let toAdd: TrackMeta[] = [];
  const toUpdate: Array<{ id: number; meta: TrackMeta }> = [];
  // Files that look different by stat but are byte-identical (touched by some
  // other tool). Refresh stat columns only — no parseFile, no tag rewrite.
  const toTouch: Array<{ id: number; mtime: number; size: number }> = [];
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    onDisk.add(filePath);
    emit({
      type: 'progress',
      phase: 'extracting',
      current: i + 1,
      total: files.length,
      currentFile: filePath
    });

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) {
      failed++;
      continue;
    }
    const mtime = Math.floor(stat.mtimeMs);
    const size = stat.size;
    const prior = existing.get(filePath);

    try {
      if (!prior) {
        toAdd.push(await extractMetadata(filePath));
        continue;
      }

      const sizeMatches = prior.size === size;
      const mtimeMatches = prior.mtime === mtime;

      if (sizeMatches && mtimeMatches) {
        // Identical by stat. Spec still requires a hash verify to catch silent
        // edits. partialHash is much cheaper than parseFile.
        const hash = await partialHash(filePath);
        if (hash === prior.hash) {
          skipped++;
        } else {
          // Stats lied — content changed underneath. Full re-extract.
          toUpdate.push({ id: prior.id, meta: await extractMetadata(filePath) });
        }
        continue;
      }

      // Stat differs (touched, or genuinely changed). Hash decides.
      const hash = await partialHash(filePath);
      if (hash === prior.hash) {
        // Touched but content identical — skip the parseFile, just refresh stats.
        toTouch.push({ id: prior.id, mtime, size });
        skipped++;
      } else {
        toUpdate.push({ id: prior.id, meta: await extractMetadata(filePath) });
      }
    } catch (err) {
      console.warn(`[sync] failed to read ${filePath}:`, (err as Error).message);
      failed++;
    }
  }

  // Files that exist in DB but no longer on disk → delete.
  const toDeleteSet = new Set<number>();
  for (const [filePath, info] of existing) {
    if (!onDisk.has(filePath) && !fs.existsSync(filePath)) {
      toDeleteSet.add(info.id);
    }
  }

  // Detect moves: a "new" file whose hash AND size match a "deleted" row is
  // the same content under a different path. Combining both fingerprints
  // makes a false-positive match practically impossible (a partial-hash
  // collision would already need to land on a file with the exact same byte
  // count). Convert each match into a single UPDATE so play_count, liked,
  // play_history etc. survive the move instead of being lost to ON DELETE
  // CASCADE.
  const fingerprint = (hash: string, size: number) => `${size}:${hash}`;
  const deletedByFingerprint = new Map<string, number>();
  for (const info of existing.values()) {
    if (toDeleteSet.has(info.id)) {
      deletedByFingerprint.set(fingerprint(info.hash, info.size), info.id);
    }
  }
  const remainingAdds: TrackMeta[] = [];
  for (const meta of toAdd) {
    const key = fingerprint(meta.fileHash, meta.fileSize);
    const matchedId = deletedByFingerprint.get(key);
    if (matchedId !== undefined) {
      toUpdate.push({ id: matchedId, meta });
      toDeleteSet.delete(matchedId);
      deletedByFingerprint.delete(key);    // each delete consumed at most once
    } else {
      remainingAdds.push(meta);
    }
  }
  toAdd = remainingAdds;
  const toDelete = [...toDeleteSet];

  // Persist all changes in a single synchronous transaction.
  emit({
    type: 'progress',
    phase: 'persisting',
    current: 0,
    total: toAdd.length + toUpdate.length + toTouch.length
  });

  const persist = db.transaction(() => {
    for (const meta of toAdd) {
      const trackId = insertTrack(meta);
      writeLyrics(trackId, meta);
    }
    for (const { id, meta } of toUpdate) {
      updateTrack(id, meta);
      writeLyrics(id, meta);
    }
    const touchStmt = db.prepare(
      'UPDATE tracks SET file_mtime = ?, file_size = ?, last_scanned = ? WHERE id = ?'
    );
    const now = Date.now();
    for (const { id, mtime: m, size: s } of toTouch) {
      touchStmt.run(m, s, now, id);
    }
    for (const id of toDelete) {
      db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    }
  });
  persist();

  upsertSetting('last_sync_at', String(Date.now()));

  // Refresh smart-playlist contents (Top 25 / Recently Added / Never Played + per-genre).
  refreshSmartPlaylists();

  const result: SyncResult = {
    added: toAdd.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    skipped,
    failed
  };
  record.status = 'done';
  record.result = result;
  emit({ type: 'done', ...result });
}

function insertTrack(meta: TrackMeta): number {
  const db = getDb();
  const artistId = upsertArtist(meta.artist);
  const albumArtistId = upsertArtist(meta.albumArtist);
  const albumId = upsertAlbum(meta.album, albumArtistId, meta.year, meta.genre, meta.artPath);

  const stmt = db.prepare(`
    INSERT INTO tracks (
      file_path, file_hash, file_size, file_mtime,
      title, artist, album_artist, album, year,
      track_number, disc_number, genre, duration,
      bitrate, sample_rate, codec,
      has_synced_lyrics, has_unsynced_lyrics,
      album_id, artist_id, last_scanned
    ) VALUES (
      @filePath, @fileHash, @fileSize, @fileMtime,
      @title, @artist, @albumArtist, @album, @year,
      @trackNumber, @discNumber, @genre, @duration,
      @bitrate, @sampleRate, @codec,
      @hasSynced, @hasUnsynced,
      @albumId, @artistId, @lastScanned
    )
  `);
  const result = stmt.run({
    filePath: meta.filePath,
    fileHash: meta.fileHash,
    fileSize: meta.fileSize,
    fileMtime: meta.fileMtime,
    title: meta.title,
    artist: meta.artist,
    albumArtist: meta.albumArtist,
    album: meta.album,
    year: meta.year,
    trackNumber: meta.trackNumber,
    discNumber: meta.discNumber,
    genre: meta.genre,
    duration: meta.duration,
    bitrate: meta.bitrate,
    sampleRate: meta.sampleRate,
    codec: meta.codec,
    hasSynced: meta.syncedLrc ? 1 : 0,
    hasUnsynced: meta.unsyncedText ? 1 : 0,
    albumId,
    artistId,
    lastScanned: Date.now()
  });
  return Number(result.lastInsertRowid);
}

function updateTrack(id: number, meta: TrackMeta): void {
  const db = getDb();
  const artistId = upsertArtist(meta.artist);
  const albumArtistId = upsertArtist(meta.albumArtist);
  const albumId = upsertAlbum(meta.album, albumArtistId, meta.year, meta.genre, meta.artPath);

  db.prepare(`
    UPDATE tracks SET
      file_path = @filePath,
      file_hash = @fileHash,
      file_size = @fileSize,
      file_mtime = @fileMtime,
      title = @title,
      artist = @artist,
      album_artist = @albumArtist,
      album = @album,
      year = @year,
      track_number = @trackNumber,
      disc_number = @discNumber,
      genre = @genre,
      duration = @duration,
      bitrate = @bitrate,
      sample_rate = @sampleRate,
      codec = @codec,
      has_synced_lyrics = @hasSynced,
      has_unsynced_lyrics = @hasUnsynced,
      album_id = @albumId,
      artist_id = @artistId,
      last_scanned = @lastScanned
    WHERE id = @id
  `).run({
    id,
    filePath: meta.filePath,
    fileHash: meta.fileHash,
    fileSize: meta.fileSize,
    fileMtime: meta.fileMtime,
    title: meta.title,
    artist: meta.artist,
    albumArtist: meta.albumArtist,
    album: meta.album,
    year: meta.year,
    trackNumber: meta.trackNumber,
    discNumber: meta.discNumber,
    genre: meta.genre,
    duration: meta.duration,
    bitrate: meta.bitrate,
    sampleRate: meta.sampleRate,
    codec: meta.codec,
    hasSynced: meta.syncedLrc ? 1 : 0,
    hasUnsynced: meta.unsyncedText ? 1 : 0,
    albumId,
    artistId,
    lastScanned: Date.now()
  });
}

function upsertArtist(name: string): number {
  const db = getDb();
  const existing = db.prepare<[string]>('SELECT id FROM artists WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare('INSERT INTO artists(name) VALUES(?)').run(name);
  return Number(result.lastInsertRowid);
}

function upsertAlbum(
  title: string,
  artistId: number | null,
  year: number | null,
  genre: string | null,
  artPath: string | null
): number {
  const db = getDb();
  const existing = db
    .prepare<[string, number | null, number | null]>(
      'SELECT id, art_path FROM albums WHERE title = ? AND (artist_id IS ? OR artist_id = ?)'
    )
    .get(title, artistId, artistId) as { id: number; art_path: string | null } | undefined;
  if (existing) {
    if (artPath && !existing.art_path) {
      db.prepare('UPDATE albums SET art_path = ? WHERE id = ?').run(artPath, existing.id);
    }
    return existing.id;
  }
  const result = db
    .prepare('INSERT INTO albums(title, artist_id, year, genre, art_path) VALUES(?, ?, ?, ?, ?)')
    .run(title, artistId, year, genre, artPath);
  return Number(result.lastInsertRowid);
}

function writeLyrics(trackId: number, meta: TrackMeta): void {
  if (!meta.syncedLrc && !meta.unsyncedText) {
    getDb().prepare('DELETE FROM lyrics WHERE track_id = ?').run(trackId);
    return;
  }
  upsertLyrics(getDb(), {
    trackId,
    syncedLrc: meta.syncedLrc,
    unsyncedText: meta.unsyncedText
  });
}

function upsertSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function refreshSmartPlaylists(): void {
  const db = getDb();

  const ensure = (smartKey: string, name: string): number => {
    const row = db.prepare<[string]>('SELECT id FROM playlists WHERE smart_key = ?').get(smartKey) as { id: number } | undefined;
    if (row) return row.id;
    const result = db
      .prepare('INSERT INTO playlists(name, read_only, smart_key) VALUES(?, 1, ?)')
      .run(name, smartKey);
    return Number(result.lastInsertRowid);
  };

  const populate = (playlistId: number, trackIds: number[]): void => {
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
    const insert = db.prepare('INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES(?, ?, ?)');
    trackIds.forEach((trackId, index) => insert.run(playlistId, trackId, index));
  };

  const seed = db.transaction(() => {
    const mostPlayedId = ensure('most-played', 'Top 25 Most Played');
    const recentAddedId = ensure('recently-added', 'Recently Added');
    const neverPlayedId = ensure('never-played', 'Never Played');

    const top25 = db.prepare(`
      SELECT t.id FROM tracks t
      JOIN play_stats s ON s.track_id = t.id
      ORDER BY s.play_count DESC, s.last_played DESC
      LIMIT 25
    `).all() as Array<{ id: number }>;
    populate(mostPlayedId, top25.map((r) => r.id));

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = db.prepare<[number]>(`
      SELECT id FROM tracks WHERE date_added >= ? ORDER BY date_added DESC
    `).all(thirtyDaysAgo) as Array<{ id: number }>;
    populate(recentAddedId, recent.map((r) => r.id));

    const never = db.prepare(`
      SELECT t.id FROM tracks t
      LEFT JOIN play_stats s ON s.track_id = t.id
      WHERE COALESCE(s.play_count, 0) = 0
      ORDER BY t.title
    `).all() as Array<{ id: number }>;
    populate(neverPlayedId, never.map((r) => r.id));

    // Per-genre smart playlists.
    const genres = db
      .prepare(`SELECT DISTINCT genre FROM tracks WHERE genre IS NOT NULL AND genre <> ''`)
      .all() as Array<{ genre: string }>;
    for (const { genre } of genres) {
      const smartKey = `genre:${genre.toLowerCase()}`;
      const playlistId = ensure(smartKey, `All ${genre}`);
      const tracks = db
        .prepare<[string]>('SELECT id FROM tracks WHERE genre = ? ORDER BY title')
        .all(genre) as Array<{ id: number }>;
      populate(playlistId, tracks.map((r) => r.id));
    }
  });
  seed();
}
