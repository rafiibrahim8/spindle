import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, type IPicture } from 'music-metadata';
import sharp from 'sharp';
import type { TrackMeta } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART_CACHE_DIR =
  process.env.ART_CACHE_DIR || path.join(__dirname, '../../data/art');

const PARTIAL_HASH_BYTES = 64 * 1024;

fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

export async function partialHash(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(PARTIAL_HASH_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PARTIAL_HASH_BYTES, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle.close();
  }
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
  const discNumber = tags.disk?.no ?? null;
  const genre = (tags.genre && tags.genre[0]) || null;

  const duration = typeof fmt.duration === 'number' ? fmt.duration : null;
  const bitrate = typeof fmt.bitrate === 'number' ? Math.round(fmt.bitrate / 1000) : null;
  const sampleRate = typeof fmt.sampleRate === 'number' ? fmt.sampleRate : null;
  const codec = (fmt.codec || fmt.container || null)?.toString().toLowerCase() || null;

  const picture = pickFrontCover(tags.picture);
  const artPath = picture ? await cacheAlbumArt(picture, fileHash) : null;

  const syncedLrc = extractSyncedLyricsFromTags(meta);
  const unsyncedText = extractUnsyncedFromTags(meta);

  let resolvedSynced = syncedLrc;
  let resolvedUnsynced = unsyncedText;

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
    artPath,
    syncedLrc: resolvedSynced,
    unsyncedText: resolvedUnsynced
  };
}

function pickFrontCover(pics: IPicture[] | undefined): IPicture | null {
  if (!pics || !pics.length) return null;
  const front = pics.find((p) =>
    typeof p.type === 'string' && /front|cover/i.test(p.type)
  );
  return front || pics[0];
}

async function cacheAlbumArt(picture: IPicture, hash: string): Promise<string> {
  const filename = `${hash}.webp`;
  const target = path.join(ART_CACHE_DIR, filename);
  if (fs.existsSync(target)) return `/art/${filename}`;
  try {
    await sharp(picture.data)
      .resize(500, 500, { fit: 'cover' })
      .webp({ quality: 85 })
      .toFile(target);
    return `/art/${filename}`;
  } catch (err) {
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
  const candidate = path.join(dir, `${base}.lrc`);
  try {
    return await fsp.readFile(candidate, 'utf8');
  } catch {
    return null;
  }
}
