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

describe('choosing where to read tags from', () => {
  // Ogg stores its length in the last page, so a parser after the duration
  // reads the whole file either way and buffering it is several times faster.
  test('Ogg-family files are buffered', async () => {
    const { shouldBufferWholeFile } = await import('../src/services/metadata.ts');
    for (const ext of ['.ogg', '.oga', '.opus', '.OGG']) {
      expect(shouldBufferWholeFile(`/music/track${ext}`, 9_000_000), ext).toBe(true);
    }
  });

  // Everything else carries its duration in a header, so the parser touches
  // about 1% of the file; reading it all would be slower, badly so for FLAC
  // and WAV, which are large and answer in a dozen reads.
  test('containers with a header-declared duration are not buffered', async () => {
    const { shouldBufferWholeFile } = await import('../src/services/metadata.ts');
    for (const ext of ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.wma', '.alac', '.aiff']) {
      expect(shouldBufferWholeFile(`/music/track${ext}`, 9_000_000), ext).toBe(false);
    }
  });

  test('an oversized file stays on the streaming path', async () => {
    const { shouldBufferWholeFile } = await import('../src/services/metadata.ts');
    expect(shouldBufferWholeFile('/music/long.ogg', 9_000_000)).toBe(true);
    expect(shouldBufferWholeFile('/music/long.ogg', 512 * 1024 * 1024)).toBe(false);
  });
});

describe.skipIf(files.length === 0)('parsing from memory matches parsing from the file', () => {
  test('tags, duration and cover bytes are identical either way', async () => {
    for (const file of files) {
      const bytes = await Bun.file(file).bytes();
      const fromBuffer = await parseBuffer(bytes, undefined, PARSE_OPTIONS);
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

  // The container comes from the bytes, with no filename to go on.
  test('the container is identified without any hint', async () => {
    for (const file of files.slice(0, 4)) {
      const bytes = await Bun.file(file).bytes();
      const parsed = await parseBuffer(bytes, undefined, PARSE_OPTIONS);
      expect(parsed.format.container, path.basename(file)).toBeTruthy();
    }
  }, 60_000);

  // Naming a container overrides what the bytes say, so a file with the wrong
  // extension parses only when nothing is named. Passing the path would carry
  // that misdetection over from the streaming path.
  test('content wins over a misleading extension', async () => {
    const mislabelled = `/tmp/spindle-mislabelled-${process.pid}.ogg`;
    const source = files.find((f) => f.toLowerCase().endsWith('.ogg'));
    if (!source) return;
    try {
      // A real Ogg under a .mp3 name: the bytes still identify it.
      const renamed = `/tmp/spindle-mislabelled-${process.pid}.mp3`;
      await Bun.write(renamed, Bun.file(source));
      const bytes = await Bun.file(renamed).bytes();
      const parsed = await parseBuffer(bytes, undefined, PARSE_OPTIONS);
      expect(parsed.format.container).toBe('Ogg');
      expect(parsed.format.duration).toBeGreaterThan(0);
      await Bun.file(renamed).delete();
    } finally {
      await Bun.file(mislabelled).delete().catch(() => {});
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
