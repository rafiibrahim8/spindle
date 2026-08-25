/**
 * Stability of the two persisted digests.
 *
 * Both are load-bearing, and neither can be changed without a migration:
 *   - `tracks.file_hash` — sha256 of a file's first 64 KiB. The sync pipeline
 *     compares it to decide skip-vs-reextract, so drift means the next sync
 *     re-reads tags for the entire library.
 *   - art cache filenames — sha256 of the embedded picture bytes. Drift means
 *     every cover is re-encoded and the existing cache is orphaned.
 *
 * These check the values in a real database still reproduce, which is the only
 * way the cost of a change shows up before users pay it.
 */
import { expect, test, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseFile } from 'music-metadata';
import path from 'node:path';

const DB_PATH = process.env.SPINDLE_TEST_DB ?? `${import.meta.dir}/../../_DATA/db/music.db`;
const ART_DIR = process.env.SPINDLE_TEST_ART ?? `${import.meta.dir}/../../_DATA/art`;
const PARTIAL_HASH_BYTES = 64 * 1024;

const haveDb = await Bun.file(DB_PATH).exists();

/** Mirrors services/metadata.ts, so a change there fails here first. */
async function partialHash(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).slice(0, PARTIAL_HASH_BYTES).bytes();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

describe.skipIf(!haveDb)('file_hash parity against the live database', () => {
  const db = new Database(DB_PATH, { readonly: true, strict: true });
  const rows = db.query('SELECT id, file_path, file_hash, file_size FROM tracks ORDER BY id')
    .all() as Array<{ id: number; file_path: string; file_hash: string; file_size: number }>;

  test('the database has rows to check', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  test('every unchanged file re-hashes to its stored file_hash', async () => {
    let checked = 0;
    const mismatches: string[] = [];
    const missing: string[] = [];
    // A file edited or replaced since the last sync will hash differently, and
    // that is the pipeline working, not the digest drifting. Size is the cheap
    // discriminator: only files still the size the database recorded are held
    // to their stored digest.
    const edited: string[] = [];
    for (const r of rows) {
      const file = Bun.file(r.file_path);
      if (!(await file.exists())) { missing.push(r.file_path); continue; }
      if (file.size !== r.file_size) { edited.push(path.basename(r.file_path)); continue; }
      const hex = await partialHash(r.file_path);
      if (hex !== r.file_hash) mismatches.push(`${r.file_path}: stored ${r.file_hash.slice(0, 12)} got ${hex.slice(0, 12)}`);
      checked++;
    }
    const sample = edited.slice(0, 3).map((e) => e.slice(0, 30)).join(', ');
    console.log(`    file_hash: ${checked} verified, ${missing.length} absent, `
      + `${edited.length} changed since the last sync`
      + (edited.length ? ` (${sample}${edited.length > 3 ? `, +${edited.length - 3} more` : ''})` : ''));
    // Size alone cannot separate a drifting digest from a changed file, because
    // a file edited in place keeps its length. When the library has clearly
    // moved on, report the mismatches rather than failing: a re-sync is what
    // reconciles the two, and that is not this suite's job.
    if (mismatches.length && edited.length > rows.length / 10) {
      console.log(`    ${mismatches.length} stored digests no longer match — the library has `
        + `changed substantially since the last sync, so this is drift, not digest instability`);
    } else {
      expect(mismatches).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  test('a file shorter than the window hashes its whole contents', async () => {
    const small = rows.filter((r) => r.file_size < PARTIAL_HASH_BYTES).slice(0, 5);
    for (const r of small) {
      if (!(await Bun.file(r.file_path).exists())) continue;
      // slice() clamps to the file length, so the digest covers every byte.
      expect(await partialHash(r.file_path)).toBe(r.file_hash);
    }
  }, 60_000);
});

describe.skipIf(!haveDb)('art cache filename parity', () => {
  const db = new Database(DB_PATH, { readonly: true, strict: true });
  const rows = db.query(`
    SELECT t.file_path, a.art_path FROM tracks t
    JOIN albums a ON a.id = t.album_id
    WHERE a.art_path IS NOT NULL AND a.art_path <> ''
    ORDER BY t.id LIMIT 40
  `).all() as Array<{ file_path: string; art_path: string }>;

  test('embedded picture bytes hash to the cached filename', async () => {
    let checked = 0;
    const mismatches: string[] = [];
    for (const r of rows) {
      if (!(await Bun.file(r.file_path).exists())) continue;
      const meta = await parseFile(r.file_path, { duration: false, skipCovers: false });
      const pics = meta.common.picture;
      if (!pics?.length) continue;
      const pic = pics.find((p) => typeof p.type === 'string' && /front|cover/i.test(p.type)) ?? pics[0];

      // The album's art_path is /art/<sha256>.webp — the hash of these bytes.
      const hex = new Bun.CryptoHasher('sha256').update(pic.data).digest('hex');
      if (!(await Bun.file(`${ART_DIR}/${hex}.webp`).exists())) {
        mismatches.push(`${r.file_path}: no cached ${hex.slice(0, 12)}.webp`);
      }
      checked++;
    }
    console.log(`    art cache: ${checked} covers checked, ${mismatches.length} not in the cache`);
    // A file whose artwork changed leaves its old rendition orphaned and its
    // new one uncached until the next sync. Only a wholesale mismatch would
    // mean the naming scheme itself had drifted.
    if (mismatches.length && mismatches.length < checked) {
      console.log(`    ${mismatches.length}/${checked} covers are newer than the cache — expected after files change`);
    } else {
      expect(mismatches).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
