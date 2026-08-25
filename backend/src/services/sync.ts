import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { getDb, prepared } from '../db/init.ts';
import type { SyncEvent, SyncResult, TrackMeta } from '../types.ts';
import { extractMetadata, partialHash } from './metadata.ts';
import { upsertLyrics } from './lyrics.ts';
import { scanDirectory } from './scanner.ts';

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

/**
 * Yield to the event loop between batches of synchronous work. Everything in
 * this process — including in-flight audio streams — shares one event loop, and
 * SQLite writes are synchronous, so a single monolithic persist over a large
 * library blocks stream delivery long enough to stutter playback.
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const PERSIST_CHUNK_SIZE = 200;

/**
 * `force` re-reads tags from every file instead of trusting the
 * size/mtime/hash short-circuit. Needed whenever the extractor learns to read
 * a field it previously ignored: the files have not changed, so an ordinary
 * sync skips them and the new columns would stay NULL forever.
 */
export function createSyncJob(rootDir: string, force = false): string {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const record: JobRecord = { id, emitter, status: 'running', events: [] };
  jobs.set(id, record);
  latestRunningJobId = id;

  // Run async, do not block.
  void runSync(rootDir, record, force)
    .catch((err) => {
      record.status = 'error';
      record.error = (err as Error).message;
      const event: SyncEvent = { type: 'error', message: record.error };
      record.events.push(event);
      emitter.emit('event', event);
    })
    .finally(() => {
      if (latestRunningJobId === id) latestRunningJobId = null;
      // Bound memory: keep only this (most recent) finished job; older
      // finished jobs and their event buffers are no longer reachable by
      // any client that matters.
      for (const [jobId, job] of jobs) {
        if (jobId !== id && job.status !== 'running') jobs.delete(jobId);
      }
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

async function runSync(rootDir: string, record: JobRecord, force = false): Promise<void> {
  const db = getDb();
  resetUpsertCaches();
  const emit = (event: SyncEvent) => {
    // Coalesce stored progress events per phase: a late-connecting SSE client
    // only needs the latest position, not thousands of intermediate ticks.
    // Live listeners still receive every event via the emitter.
    const last = record.events[record.events.length - 1];
    if (event.type === 'progress' && last?.type === 'progress' && last.phase === event.phase) {
      record.events[record.events.length - 1] = event;
    } else {
      record.events.push(event);
    }
    record.emitter.emit('event', event);
  };

  emit({ type: 'progress', phase: 'scanning', current: 0, total: 0 });

  const files = await scanDirectory(rootDir);
  emit({ type: 'progress', phase: 'scanning', current: files.length, total: files.length });

  // Persist music root only once the scan succeeded, so a bad path can't
  // clobber a previously saved good setting.
  upsertSetting('music_root', rootDir);

  // Build the existing index ahead of time. Includes size so we can decide
  // rclone-style: identical-by-stat → cheap hash verify; differing stat → still
  // hash-check before paying the cost of a full metadata parse.
  const existing = new Map<string, { id: number; mtime: number; hash: string; size: number }>();
  const existingRows = db
    .query('SELECT id, file_path, file_mtime, file_hash, file_size FROM tracks')
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

      if (force) {
        toUpdate.push({ id: prior.id, meta: await extractMetadata(filePath) });
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
  let existenceChecks = 0;
  for (const [filePath, info] of existing) {
    if (!onDisk.has(filePath) && !fs.existsSync(filePath)) {
      toDeleteSet.add(info.id);
    }
    if (++existenceChecks % 500 === 0) await yieldToEventLoop();
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

  // Persist in chunked transactions with event-loop yields between them, so
  // a large sync never starves concurrent requests (especially audio
  // streams). Trade-off vs. one big transaction: a crash mid-persist leaves a
  // partially synced library, which the next sync repairs.
  const touchStmt = db.query(
    'UPDATE tracks SET file_mtime = ?, file_size = ?, last_scanned = ? WHERE id = ?'
  );
  const deleteStmt = db.query('DELETE FROM tracks WHERE id = ?');
  const touchedAt = Date.now();

  const persistOps: Array<() => void> = [
    ...toAdd.map((meta) => () => {
      const trackId = insertTrack(meta);
      writeLyrics(trackId, meta);
    }),
    ...toUpdate.map(({ id, meta }) => () => {
      updateTrack(id, meta);
      writeLyrics(id, meta);
    }),
    ...toTouch.map(({ id, mtime: m, size: s }) => () => {
      touchStmt.run(m, s, touchedAt, id);
    }),
    ...toDelete.map((id) => () => {
      deleteStmt.run(id);
    })
  ];

  emit({ type: 'progress', phase: 'persisting', current: 0, total: persistOps.length });

  const runChunk = db.transaction((ops: Array<() => void>) => {
    for (const op of ops) op();
  });
  for (let i = 0; i < persistOps.length; i += PERSIST_CHUNK_SIZE) {
    runChunk(persistOps.slice(i, i + PERSIST_CHUNK_SIZE));
    emit({
      type: 'progress',
      phase: 'persisting',
      current: Math.min(i + PERSIST_CHUNK_SIZE, persistOps.length),
      total: persistOps.length
    });
    await yieldToEventLoop();
  }

  // Garbage-collect rows orphaned by deletes/moves: albums with no remaining
  // tracks, then artists referenced by neither a track nor a surviving album
  // (albums first, so an empty album doesn't keep its artist alive).
  db.exec(`
    DELETE FROM albums WHERE id NOT IN (
      SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL
    );
    DELETE FROM artists WHERE id NOT IN (
      SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL
      UNION
      SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL
    );
  `);

  upsertSetting('last_sync_at', String(Date.now()));

  // Refresh smart-playlist contents (Top 25 / Recently Added / Never Played + per-genre).
  await refreshSmartPlaylists();

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

// Per-sync-run lookup caches so repeated tracks of the same artist/album skip
// the SELECT entirely. Reset at the start of each run; safe because only one
// sync job runs at a time and nothing else writes these tables mid-sync.
const artistIdByName = new Map<string, number>();
const albumCacheByKey = new Map<string, { id: number; hasArt: boolean }>();

function resetUpsertCaches(): void {
  artistIdByName.clear();
  albumCacheByKey.clear();
}

function insertTrack(meta: TrackMeta): number {
  const db = getDb();
  const artistId = upsertArtist(meta.artist);
  const albumArtistId = upsertArtist(meta.albumArtist);
  const albumId = upsertAlbum(meta.album, albumArtistId, meta.year, meta.genre, meta.artPath);

  const stmt = prepared(db, `
    INSERT INTO tracks (
      file_path, file_hash, file_size, file_mtime,
      title, artist, album_artist, album, year,
      track_number, disc_number, genre, duration,
      bitrate, sample_rate, codec, channels,
      track_total, disc_total, release_date, isrc, woas,
      has_synced_lyrics, has_unsynced_lyrics,
      album_id, artist_id, last_scanned
    ) VALUES (
      @filePath, @fileHash, @fileSize, @fileMtime,
      @title, @artist, @albumArtist, @album, @year,
      @trackNumber, @discNumber, @genre, @duration,
      @bitrate, @sampleRate, @codec, @channels,
      @trackTotal, @discTotal, @releaseDate, @isrc, @woas,
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
    channels: meta.channels,
    trackTotal: meta.trackTotal,
    discTotal: meta.discTotal,
    releaseDate: meta.releaseDate,
    isrc: meta.isrc,
    woas: meta.woas,
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

  prepared(db, `
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
      channels = @channels,
      track_total = @trackTotal,
      disc_total = @discTotal,
      release_date = @releaseDate,
      isrc = @isrc,
      woas = @woas,
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
    channels: meta.channels,
    trackTotal: meta.trackTotal,
    discTotal: meta.discTotal,
    releaseDate: meta.releaseDate,
    isrc: meta.isrc,
    woas: meta.woas,
    hasSynced: meta.syncedLrc ? 1 : 0,
    hasUnsynced: meta.unsyncedText ? 1 : 0,
    albumId,
    artistId,
    lastScanned: Date.now()
  });
}

function upsertArtist(name: string): number {
  const cached = artistIdByName.get(name);
  if (cached !== undefined) return cached;

  const db = getDb();
  const existing = prepared(db, 'SELECT id FROM artists WHERE name = ?').get(name) as { id: number } | null;
  const id = existing
    ? existing.id
    : Number(prepared(db, 'INSERT INTO artists(name) VALUES(?)').run(name).lastInsertRowid);
  artistIdByName.set(name, id);
  return id;
}

function upsertAlbum(
  title: string,
  artistId: number | null,
  year: number | null,
  genre: string | null,
  artPath: string | null
): number {
  const db = getDb();
  // The separator is a NUL so a title containing it cannot forge another
  // artist's key. Written as an escape rather than embedded literally: a raw
  // NUL makes the file read as binary, and tools that skip binary files then
  // pass over it in silence.
  const key = `${artistId ?? ''}\0${title}`;
  const cached = albumCacheByKey.get(key);
  if (cached) {
    // First track of the album may lack embedded art; later ones can fill it.
    if (artPath && !cached.hasArt) {
      prepared(db, 'UPDATE albums SET art_path = ? WHERE id = ?').run(artPath, cached.id);
      cached.hasArt = true;
    }
    return cached.id;
  }

  const existing = prepared(
    db,
    'SELECT id, art_path FROM albums WHERE title = ? AND (artist_id IS ? OR artist_id = ?)'
  ).get(title, artistId, artistId) as { id: number; art_path: string | null } | null;
  if (existing) {
    let hasArt = Boolean(existing.art_path);
    if (artPath && !hasArt) {
      prepared(db, 'UPDATE albums SET art_path = ? WHERE id = ?').run(artPath, existing.id);
      hasArt = true;
    }
    albumCacheByKey.set(key, { id: existing.id, hasArt });
    return existing.id;
  }
  const result = prepared(
    db,
    'INSERT INTO albums(title, artist_id, year, genre, art_path) VALUES(?, ?, ?, ?, ?)'
  ).run(title, artistId, year, genre, artPath);
  const id = Number(result.lastInsertRowid);
  albumCacheByKey.set(key, { id, hasArt: Boolean(artPath) });
  return id;
}

function writeLyrics(trackId: number, meta: TrackMeta): void {
  if (!meta.syncedLrc && !meta.unsyncedText) {
    prepared(getDb(), 'DELETE FROM lyrics WHERE track_id = ?').run(trackId);
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
    .query('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

async function refreshSmartPlaylists(): Promise<void> {
  const db = getDb();

  const ensure = (smartKey: string, name: string): number => {
    const bySmartKey = db.query('SELECT id FROM playlists WHERE smart_key = ?');
    // ON CONFLICT(name) DO NOTHING: a user-created playlist may already own
    // this name (playlists.name is UNIQUE) — don't let that abort the sync.
    const insert = db.query(
      'INSERT INTO playlists(name, read_only, smart_key) VALUES(?, 1, ?) ON CONFLICT(name) DO NOTHING'
    );
    let row = bySmartKey.get(smartKey) as { id: number } | null;
    if (row) return row.id;
    insert.run(name, smartKey);
    row = bySmartKey.get(smartKey) as { id: number } | null;
    if (row) return row.id;
    // Name taken by a non-smart playlist — retry with a disambiguating suffix.
    insert.run(`${name} (Smart)`, smartKey);
    row = bySmartKey.get(smartKey) as { id: number } | null;
    if (!row) throw new Error(`Could not create smart playlist "${name}" (name conflict)`);
    return row.id;
  };

  // One transaction per playlist (delete + reinsert stays atomic per list),
  // with an event-loop yield between playlists so a rebuild across many
  // genres doesn't block concurrent requests.
  const populate = db.transaction((playlistId: number, trackIds: number[]): void => {
    db.query('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
    const insert = db.query('INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES(?, ?, ?)');
    trackIds.forEach((trackId, index) => insert.run(playlistId, trackId, index));
  });

  const mostPlayedId = ensure('most-played', 'Top 25 Most Played');
  const recentAddedId = ensure('recently-added', 'Recently Added');
  const neverPlayedId = ensure('never-played', 'Never Played');

  const top25 = db.query(`
    SELECT t.id FROM tracks t
    JOIN play_stats s ON s.track_id = t.id
    ORDER BY s.play_count DESC, s.last_played DESC
    LIMIT 25
  `).all() as Array<{ id: number }>;
  populate(mostPlayedId, top25.map((r) => r.id));
  await yieldToEventLoop();

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = db.query(`
    SELECT id FROM tracks WHERE date_added >= ? ORDER BY date_added DESC
  `).all(thirtyDaysAgo) as Array<{ id: number }>;
  populate(recentAddedId, recent.map((r) => r.id));
  await yieldToEventLoop();

  const never = db.query(`
    SELECT t.id FROM tracks t
    LEFT JOIN play_stats s ON s.track_id = t.id
    WHERE COALESCE(s.play_count, 0) = 0
    ORDER BY t.title
  `).all() as Array<{ id: number }>;
  populate(neverPlayedId, never.map((r) => r.id));
  await yieldToEventLoop();

  // Per-genre smart playlists. Genres are grouped case-insensitively so
  // "Rock" and "rock" share one playlist; MIN(genre) picks a stable display
  // spelling.
  const genres = db
    .query(`
      SELECT MIN(genre) AS genre FROM tracks
      WHERE genre IS NOT NULL AND genre <> ''
      GROUP BY genre COLLATE NOCASE
    `)
    .all() as Array<{ genre: string }>;
  for (const { genre } of genres) {
    const smartKey = `genre:${genre.toLowerCase()}`;
    const playlistId = ensure(smartKey, `All ${genre}`);
    const tracks = db
      .query('SELECT id FROM tracks WHERE genre = ? COLLATE NOCASE ORDER BY title')
      .all(genre) as Array<{ id: number }>;
    populate(playlistId, tracks.map((r) => r.id));
    await yieldToEventLoop();
  }
}
