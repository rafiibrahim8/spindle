import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Cached album art is written by the scanner at 500x500 (~45 KB each) and was
 * previously served at that one size everywhere — including the 40 px
 * thumbnails in the virtualised track and queue lists. A 500 px WebP decodes
 * to ~1 MB of bitmap, so scrolling a list on a phone meant a stream of decodes
 * and a lot of resident memory for images displayed at a twelfth of their
 * size. That main-thread work is exactly what starves audio playback.
 *
 * `?w=` serves a downscaled variant instead, generated once and cached to
 * disk next to the original. Widths are whitelisted: the query string reaches
 * sharp, and an open-ended one would let a caller fill the disk with
 * arbitrary renditions.
 */
const VARIANT_WIDTHS = new Set([64, 128, 256]);

/** Content-addressed names only — this string becomes a filesystem path. */
const ART_FILENAME = /^[0-9a-f]{64}\.webp$/;

/**
 * Renditions in flight, keyed by variant path. One album's art is shared by
 * every track on it, so a list view can request the same variant a dozen times
 * at once; without this each request would spawn its own sharp pipeline.
 */
const inFlight = new Map<string, Promise<void>>();

function renderVariant(source: string, target: string, width: number): Promise<void> {
  const existing = inFlight.get(target);
  if (existing) return existing;

  const job = (async () => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // Render to a unique temp name and rename into place: rename is atomic, so
    // a concurrent reader never sees a half-written file.
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await sharp(source).resize(width, width, { fit: 'cover' }).webp({ quality: 80 }).toFile(tmp);
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw err;
    }
  })().finally(() => inFlight.delete(target));

  inFlight.set(target, job);
  return job;
}

export function createArtRouter(artCacheDir: string): express.Router {
  const router = express.Router();

  // Names are content hashes, so a given URL's bytes can never change.
  const CACHE_CONTROL = 'public, max-age=2592000, immutable';

  router.get('/:file', (req, res, next) => {
    const width = Number(req.query.w);
    // Anything unrecognised falls through to the static handler, which serves
    // the full-size original — a bad ?w= degrades, it doesn't 404.
    if (!VARIANT_WIDTHS.has(width) || !ART_FILENAME.test(req.params.file)) {
      next();
      return;
    }

    const source = path.join(artCacheDir, req.params.file);
    const target = path.join(artCacheDir, String(width), req.params.file);

    const send = () => res.sendFile(target, { headers: { 'Cache-Control': CACHE_CONTROL } });

    if (fs.existsSync(target)) {
      send();
      return;
    }
    if (!fs.existsSync(source)) {
      next();
      return;
    }
    renderVariant(source, target, width).then(send, (err: Error) => {
      console.warn(`[art] resize to ${width}px failed for ${req.params.file}:`, err.message);
      next();    // serve the original rather than nothing
    });
  });

  return router;
}
