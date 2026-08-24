/**
 * Tag extraction reads the file into memory and parses from there, falling back
 * to reading through the file descriptor for anything too large to hold. These
 * check the two paths agree, since only one of them runs in practice.
 */
import { expect, test, describe } from 'bun:test';
import { parseBuffer, parseFile } from 'music-metadata';
import fs from 'node:fs';
import path from 'node:path';

const MUSIC_ROOT = process.env.SPINDLE_TEST_MUSIC ?? '/hdd/ADM/Music';
const PARSE_OPTIONS = { duration: true, skipCovers: false } as const;
const EXTENSIONS = new Set(['mp3', 'ogg', 'aac', 'm4a', 'flac', 'wav', 'opus', 'wma', 'alac', 'aiff']);

async function sample(limit: number): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Bun.Glob('**/*').scan({ cwd: MUSIC_ROOT, absolute: true, onlyFiles: true })) {
    if (!EXTENSIONS.has(path.extname(f).toLowerCase().slice(1))) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out.sort();
}

// Bun.file().exists() is false for a directory, so stat it instead.
const haveLibrary = fs.existsSync(MUSIC_ROOT) && fs.statSync(MUSIC_ROOT).isDirectory();
const files = haveLibrary ? await sample(12) : [];
const digest = (b?: Uint8Array) => (b ? new Bun.CryptoHasher('sha256').update(b).digest('hex') : null);

describe.skipIf(files.length === 0)('parsing from memory matches parsing from the file', () => {
  test('tags, duration and cover bytes are identical either way', async () => {
    for (const file of files) {
      const bytes = await Bun.file(file).bytes();
      const fromBuffer = await parseBuffer(bytes, { path: file, size: bytes.length }, PARSE_OPTIONS);
      const fromFile = await parseFile(file, PARSE_OPTIONS);

      const where = path.basename(file);
      expect(fromBuffer.common.title, where).toBe(fromFile.common.title);
      expect(fromBuffer.common.artist, where).toBe(fromFile.common.artist);
      expect(fromBuffer.common.album, where).toBe(fromFile.common.album);
      expect(fromBuffer.format.duration, where).toBe(fromFile.format.duration);
      expect(fromBuffer.format.codec, where).toBe(fromFile.format.codec);
      expect(digest(fromBuffer.common.picture?.[0]?.data), where)
        .toBe(digest(fromFile.common.picture?.[0]?.data));
    }
  }, 120_000);

  // The container is inferred from the path; without it a caller would have to
  // name a mimeType, and naming the wrong one silently yields nothing.
  test('the path hint identifies the container', async () => {
    for (const file of files.slice(0, 4)) {
      const bytes = await Bun.file(file).bytes();
      const parsed = await parseBuffer(bytes, { path: file, size: bytes.length }, PARSE_OPTIONS);
      expect(parsed.format.container, path.basename(file)).toBeTruthy();
    }
  }, 60_000);

  // The digest is taken from the same buffer the parser gets, and must equal
  // the one a standalone 64 KiB read produces — it is persisted, so a change
  // would re-extract the whole library.
  test('hashing a held buffer matches hashing a separate 64 KiB read', async () => {
    const { partialHash } = await import('../src/services/metadata.ts');
    for (const file of files.slice(0, 6)) {
      const whole = await Bun.file(file).bytes();
      const fromWhole = new Bun.CryptoHasher('sha256').update(whole.subarray(0, 64 * 1024)).digest('hex');
      expect(fromWhole, path.basename(file)).toBe(await partialHash(file));
    }
  }, 60_000);
});
