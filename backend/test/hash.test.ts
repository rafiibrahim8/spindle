/**
 * Digest parity between the old and new implementations.
 *
 * Two hashes are persisted and therefore load-bearing:
 *   - `tracks.file_hash` — sha256 of a file's first 64 KiB. The sync pipeline
 *     compares it to decide skip-vs-reextract, so drift means the next sync
 *     re-reads tags for the entire library.
 *   - art cache filenames — sha256 of the embedded picture bytes. Drift means
 *     every cover is re-encoded and the existing cache is orphaned.
 *
 * The old code used node:crypto + fs.read into a 64 KiB buffer; the rewrite uses
 * Bun.CryptoHasher + Bun.file().slice(). These tests assert the swap is a no-op
 * against the real database, not just in principle.
 */
import { expect, test, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { parseFile } from 'music-metadata';

const DB_PATH = process.env.SPINDLE_TEST_DB ?? `${import.meta.dir}/../../_DATA/db/music.db`;
const ART_DIR = process.env.SPINDLE_TEST_ART ?? `${import.meta.dir}/../../_DATA/art`;
const PARTIAL_HASH_BYTES = 64 * 1024;

const haveDb = await Bun.file(DB_PATH).exists();

/** The rewrite's implementation. */
async function partialHashBun(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).slice(0, PARTIAL_HASH_BYTES).bytes();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** The current implementation, verbatim in behaviour. */
async function partialHashNode(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(PARTIAL_HASH_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PARTIAL_HASH_BYTES, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle.close();
  }
}

describe.skipIf(!haveDb)('file_hash parity against the live database', () => {
  const db = new Database(DB_PATH, { readonly: true, strict: true });
  const rows = db.query('SELECT id, file_path, file_hash, file_size FROM tracks ORDER BY id')
    .all() as Array<{ id: number; file_path: string; file_hash: string; file_size: number }>;

  test('the database has rows to check', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  test('every present file re-hashes to its stored file_hash', async () => {
    let checked = 0;
    const mismatches: string[] = [];
    const missing: string[] = [];
    for (const r of rows) {
      if (!(await Bun.file(r.file_path).exists())) { missing.push(r.file_path); continue; }
      const hex = await partialHashBun(r.file_path);
      if (hex !== r.file_hash) mismatches.push(`${r.file_path}: stored ${r.file_hash.slice(0, 12)} got ${hex.slice(0, 12)}`);
      checked++;
    }
    console.log(`    file_hash: ${checked} verified, ${missing.length} absent from disk`);
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  test('Bun and node implementations agree, including files under 64 KiB', async () => {
    const sample = rows.slice(0, 25);
    const small = rows.filter((r) => r.file_size < PARTIAL_HASH_BYTES).slice(0, 5);
    for (const r of [...sample, ...small]) {
      if (!(await Bun.file(r.file_path).exists())) continue;
      expect(await partialHashBun(r.file_path)).toBe(await partialHashNode(r.file_path));
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

      const nodeHex = crypto.createHash('sha256').update(pic.data).digest('hex');
      const bunHex = new Bun.CryptoHasher('sha256').update(pic.data).digest('hex');
      expect(bunHex).toBe(nodeHex);

      // The album's art_path is /art/<sha256>.webp — the hash of these bytes.
      if (!(await Bun.file(`${ART_DIR}/${bunHex}.webp`).exists())) {
        mismatches.push(`${r.file_path}: no cached ${bunHex.slice(0, 12)}.webp`);
      }
      checked++;
    }
    console.log(`    art cache: ${checked} covers verified present`);
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
