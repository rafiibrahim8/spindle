import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile, type IPicture } from 'music-metadata';
import { ART_CACHE_DIR } from '../env.ts';
import type { TrackMeta } from '../types.ts';

const PARTIAL_HASH_BYTES = 64 * 1024;

fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

/**
 * sha256 of a file's first 64 KiB.
 *
 * This value is persisted in tracks.file_hash and drives the sync pipeline's
 * skip-vs-reextract decision, so it must keep producing exactly what the
 * node:crypto implementation produced — otherwise the next sync re-reads tags
 * for the entire library. test/hash.test.ts checks all 536 rows against the
 * live database.
 */
export async function partialHash(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).slice(0, PARTIAL_HASH_BYTES).bytes();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export async function extractMetadata(filePath: string): Promise<TrackMeta> {
  const stat = await fsp.stat(filePath);
  const fileHash = await partialHash(filePath);
  const meta = await parseFile(filePath, { duration: true, skipCovers: false });

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
 * `fit: 'inside'` bounds both axes without distorting. sharp's `cover` used to
 * center-crop to an exact square, which Bun.Image cannot do — it has no crop
 * operation at all. The frontend renders art in fixed square boxes with
 * `object-fit: cover`, so the crop simply happens in the browser instead and
 * the result on screen is unchanged.
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
