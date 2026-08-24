import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseBuffer, parseFile, type IPicture } from 'music-metadata';
import { ART_CACHE_DIR } from '../env.ts';
import type { TrackMeta } from '../types.ts';

const PARTIAL_HASH_BYTES = 64 * 1024;

/**
 * Above this, tags are read straight from the file rather than from memory.
 * Nothing in a music library is normally this large — the ceiling exists so a
 * stray multi-gigabyte file cannot be pulled into memory wholesale.
 */
const MAX_IN_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Containers whose tags cost a full read anyway.
 *
 * An Ogg stream stores its length as the granule position of the last page, so
 * a parser after the duration walks every page to the end of the file — 5318
 * reads for a 7 MB track, most of them a 27-byte page header. Handing it the
 * bytes instead is worth several times the parse.
 *
 * No other container here behaves that way: FLAC's STREAMINFO, WAV's header and
 * MP3's Xing frame all carry the duration up front, and those parsers touch
 * about 1% of the file. Reading a 37 MB FLAC in full to save a dozen reads is
 * eight times slower, so they keep streaming.
 */
const READ_WHOLE_FILE = new Set(['.ogg', '.oga', '.opus']);

/**
 * Whether tags for this file are cheaper to read from memory than from disk.
 * Exported so the choice can be asserted directly; the cost of getting it wrong
 * is invisible in an all-Ogg library and severe in a FLAC one.
 */
export function shouldBufferWholeFile(filePath: string, size: number): boolean {
  return READ_WHOLE_FILE.has(path.extname(filePath).toLowerCase()) && size <= MAX_IN_MEMORY_BYTES;
}

const PARSE_OPTIONS = { duration: true, skipCovers: false } as const;

fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

/** sha256 of the first 64 KiB of `bytes`, or of all of it when shorter. */
function hashPrefix(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes.subarray(0, PARTIAL_HASH_BYTES)).digest('hex');
}

/**
 * sha256 of a file's first 64 KiB.
 *
 * This value is persisted in tracks.file_hash and drives the sync pipeline's
 * skip-vs-reextract decision, so it must keep producing exactly the same digest
 * — otherwise the next sync re-reads tags for the entire library.
 * test/hash.test.ts checks every row against the live database.
 *
 * The sync pipeline calls this for every file it considers, including the ones
 * it goes on to skip, so it reads 64 KiB and no more.
 */
export async function partialHash(filePath: string): Promise<string> {
  return hashPrefix(await Bun.file(filePath).slice(0, PARTIAL_HASH_BYTES).bytes());
}

export async function extractMetadata(filePath: string): Promise<TrackMeta> {
  const stat = await fsp.stat(filePath);

  // Read the file once and parse from memory, where that is the cheaper shape.
  //
  // Handing music-metadata a path makes it tokenize straight from the file
  // descriptor, one read() per token. For an Ogg — which is read to the last
  // page regardless — that is thousands of tiny reads covering the whole file,
  // and replacing them with a single sequential read cuts extraction several
  // fold. The digest then comes from the same bytes, saving another read.
  const inMemory = shouldBufferWholeFile(filePath, stat.size) ? await Bun.file(filePath).bytes() : null;
  const fileHash = inMemory ? hashPrefix(inMemory) : await partialHash(filePath);
  // `path` lets the parser pick a container from the extension and fall back to
  // sniffing content. A hard-coded mimeType would misread every format but the
  // one it names.
  const meta = inMemory
    ? await parseBuffer(inMemory, { path: filePath, size: inMemory.length }, PARSE_OPTIONS)
    : await parseFile(filePath, PARSE_OPTIONS);

  const tags = meta.common;
  const fmt = meta.format;

  const title = (tags.title || path.basename(filePath, path.extname(filePath))).trim();
  const artist = (tags.artist || 'Unknown Artist').trim();
  const albumArtist = (tags.albumartist || tags.artist || 'Unknown Artist').trim();
  const album = (tags.album || 'Unknown Album').trim();
  const year = typeof tags.year === 'number' ? tags.year : null;

  const trackNumber = tags.track?.no ?? null;
  const trackTotal = tags.track?.of ?? null;
  const discNumber = tags.disk?.no ?? null;
  const discTotal = tags.disk?.of ?? null;
  const genre = (tags.genre && tags.genre[0]) || null;
  // `year` above is the integer for sorting; this keeps the full date when the
  // file has one ("2022-02-10").
  const releaseDate = typeof tags.date === 'string' && tags.date.trim() ? tags.date.trim() : null;
  const isrc = (Array.isArray(tags.isrc) && tags.isrc[0]) || null;

  const duration = typeof fmt.duration === 'number' ? fmt.duration : null;
  const bitrate = typeof fmt.bitrate === 'number' ? Math.round(fmt.bitrate / 1000) : null;
  const sampleRate = typeof fmt.sampleRate === 'number' ? fmt.sampleRate : null;
  const codec = (fmt.codec || fmt.container || null)?.toString().toLowerCase() || null;
  const channels = typeof fmt.numberOfChannels === 'number' ? fmt.numberOfChannels : null;

  const woas = readNativeTag(meta, 'WOAS');

  const picture = pickFrontCover(tags.picture);
  const artPath = picture ? await cacheAlbumArt(picture) : null;

  const syncedLrc = extractSyncedLyricsFromTags(meta);
  const unsyncedText = extractUnsyncedFromTags(meta);

  let resolvedSynced = syncedLrc;
  const resolvedUnsynced = unsyncedText;

  if (!resolvedSynced) {
    const sidecar = await readSidecarLrc(filePath);
    if (sidecar) resolvedSynced = sidecar;
  }

  return {
    filePath,
    fileHash,
    fileSize: stat.size,
    fileMtime: Math.floor(stat.mtimeMs),
    title,
    artist,
    albumArtist,
    album,
    year,
    trackNumber,
    discNumber,
    genre,
    duration,
    bitrate,
    sampleRate,
    codec,
    channels,
    trackTotal,
    discTotal,
    releaseDate,
    isrc,
    woas,
    artPath,
    syncedLrc: resolvedSynced,
    unsyncedText: resolvedUnsynced
  };
}

/**
 * Read a tag by its raw name across every native tag format in the file.
 * Needed for fields music-metadata does not normalise into `common` — WOAS is
 * a Vorbis comment key here and an ID3 frame id in MP3s, and neither surfaces
 * as a common field.
 */
function readNativeTag(meta: Awaited<ReturnType<typeof parseFile>>, wanted: string): string | null {
  const target = wanted.toUpperCase();
  for (const frames of Object.values(meta.native || {})) {
    for (const frame of frames) {
      if (!frame || !frame.id || String(frame.id).toUpperCase() !== target) continue;
      const value = typeof frame.value === 'string'
        ? frame.value
        : (frame.value && typeof frame.value === 'object' && 'url' in frame.value
            ? String((frame.value as { url?: unknown }).url ?? '')
            : null);
      const trimmed = value?.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pickFrontCover(pics: IPicture[] | undefined): IPicture | null {
  if (!pics || !pics.length) return null;
  const front = pics.find((p) => typeof p.type === 'string' && /front|cover/i.test(p.type));
  return front || pics[0];
}

/**
 * Cache one cover as WebP, bounded to 500px.
 *
 * Keyed on the picture bytes (not the track hash) so identical embedded art
 * across an album is encoded exactly once and every track shares the file. The
 * name is that sha256, which is also what makes the existing cache reusable —
 * see test/hash.test.ts.
 *
 * `fit: 'inside'` bounds both axes without distorting, which leaves a
 * non-square source stored non-square — 13 of the covers in a 536-track library
 * measured that way. Cropping to an exact square is not an option: Bun.Image
 * has no crop operation. It does not need one, because the frontend renders art
 * in fixed square boxes with `object-fit: cover`, so the crop happens in the
 * browser and only the stored geometry differs.
 */
async function cacheAlbumArt(picture: IPicture): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256').update(picture.data).digest('hex');
  const filename = `${hash}.webp`;
  const target = path.join(ART_CACHE_DIR, filename);
  if (fs.existsSync(target)) return `/art/${filename}`;
  try {
    await new Bun.Image(picture.data)
      .resize(500, 500, { fit: 'inside' })
      .webp({ quality: 85 })
      .write(target);
    return `/art/${filename}`;
  } catch (err) {
    // Bun.Image decodes JPEG, PNG, WebP, GIF and BMP on Linux; TIFF and the
    // HEIC/AVIF family are rejected with ERR_IMAGE_FORMAT_UNSUPPORTED.
    console.warn(`[metadata] art cache failed for ${hash}:`, (err as Error).message);
    return '';
  }
}

function extractSyncedLyricsFromTags(meta: Awaited<ReturnType<typeof parseFile>>): string | null {
  const native = meta.native || {};
  for (const frames of Object.values(native)) {
    for (const frame of frames) {
      if (!frame || !frame.id) continue;
      const id = frame.id.toUpperCase();
      if (id === 'SYLT') {
        const value = frame.value;
        if (value && typeof value === 'object' && Array.isArray((value as { synchronizedText?: unknown }).synchronizedText)) {
          const lines = ((value as { synchronizedText: Array<{ timestamp?: number; text?: string }> }).synchronizedText)
            .filter((l) => typeof l.text === 'string' && Number.isFinite(l.timestamp))
            .map((l) => formatLrcLine(l.timestamp || 0, l.text || ''));
          if (lines.length) return lines.join('\n');
        }
      }
      if (id === 'USLT') {
        const text = readUsltText(frame.value);
        if (text && /\[\d{1,2}:\d{2}/.test(text)) return text;
      }
      if (id === 'LYRICS' || id === 'UNSYNCEDLYRICS') {
        const text = typeof frame.value === 'string' ? frame.value : null;
        if (text && /\[\d{1,2}:\d{2}/.test(text)) return text;
      }
    }
  }
  return null;
}

function extractUnsyncedFromTags(meta: Awaited<ReturnType<typeof parseFile>>): string | null {
  if (Array.isArray(meta.common.lyrics) && meta.common.lyrics.length) {
    const joined = meta.common.lyrics
      .map((l: unknown) => (typeof l === 'string' ? l : (l as { text?: string }).text || ''))
      .filter(Boolean)
      .join('\n');
    if (joined && !/\[\d{1,2}:\d{2}/.test(joined)) return joined;
  }
  const native = meta.native || {};
  for (const frames of Object.values(native)) {
    for (const frame of frames) {
      if (!frame || !frame.id) continue;
      const id = frame.id.toUpperCase();
      if (id === 'USLT' || id === 'LYRICS' || id === 'UNSYNCEDLYRICS') {
        const text = readUsltText(frame.value);
        if (text && !/\[\d{1,2}:\d{2}/.test(text)) return text;
      }
    }
  }
  return null;
}

function readUsltText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'text' in value) {
    const t = (value as { text?: unknown }).text;
    return typeof t === 'string' ? t : null;
  }
  return null;
}

function formatLrcLine(timestampMs: number, text: string): string {
  const seconds = Math.max(0, timestampMs / 1000);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
  return `[${pad2(m)}:${pad2(s)}.${pad2(cs)}]${text}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

async function readSidecarLrc(filePath: string): Promise<string | null> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const candidate = Bun.file(path.join(dir, `${base}.lrc`));
  return (await candidate.exists()) ? candidate.text() : null;
}
