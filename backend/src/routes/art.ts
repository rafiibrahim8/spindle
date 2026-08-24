import fs from 'node:fs';
import path from 'node:path';
import { ART_CACHE_DIR } from '../env.ts';
import { notFound } from '../http/respond.ts';
import { resolveWithin, serveFile } from '../http/static.ts';

/**
 * The scanner caches album art at up to 500px. Serving that one size
 * everywhere would put a 500px WebP — roughly 1 MB of decoded bitmap — behind
 * every 40px thumbnail in the virtualised track and queue lists, so scrolling
 * on a phone would mean a stream of decodes and a lot of resident memory for
 * images displayed at a twelfth of their size. That main-thread work is exactly
 * what starves audio playback.
 *
 * `?w=` serves a downscaled variant instead, generated once and cached to disk
 * next to the original. Widths are whitelisted: the query string reaches an
 * image encoder, and an open-ended one would let a caller fill the disk with
 * arbitrary renditions.
 */
const VARIANT_WIDTHS = new Set([64, 128, 256]);

/** Content-addressed names only — this string becomes a filesystem path. */
const ART_FILENAME = /^[0-9a-f]{64}\.webp$/;

const CACHE_CONTROL = 'public, max-age=2592000, immutable';

/**
 * Renditions in flight, keyed by variant path. One album's art is shared by
 * every track on it, so a list view can request the same variant a dozen times
 * at once; without this each request would spawn its own encode.
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
      // Width only, with no height: `?w=` is a width contract, and omitting the
      // height keeps the source's aspect ratio. For the square sources that
      // make up almost the whole library this is a plain scale.
      await new Bun.Image(source).resize(width).webp({ quality: 80 }).write(tmp);
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw err;
    }
  })().finally(() => inFlight.delete(target));

  inFlight.set(target, job);
  return job;
}

/**
 * Serve one cached cover, optionally downscaled.
 *
 * An unrecognised `?w=` is not an error: it falls through to the full-size
 * original, so a bad width degrades rather than 404s.
 */
export async function serveArtFile(req: Request & { params: { file: string } }): Promise<Response> {
  const file = req.params.file;
  const original = resolveWithin(ART_CACHE_DIR, `/${file}`);
  if (!original) return notFound();

  const width = Number(new URL(req.url).searchParams.get('w'));
  const wantsVariant = VARIANT_WIDTHS.has(width) && ART_FILENAME.test(file);

  if (wantsVariant) {
    const target = path.join(ART_CACHE_DIR, String(width), file);
    const cached = await serveFile(target, req, { cacheControl: CACHE_CONTROL });
    if (cached) return cached;

    if (await Bun.file(original).exists()) {
      try {
        await renderVariant(original, target, width);
        const rendered = await serveFile(target, req, { cacheControl: CACHE_CONTROL });
        if (rendered) return rendered;
      } catch (err) {
        // Serve the original rather than nothing. Bun.Image decodes JPEG, PNG,
        // WebP, GIF and BMP on Linux, so this is mostly reachable for genuinely
        // corrupt cache entries.
        console.warn(`[art] resize to ${width}px failed for ${file}:`, (err as Error).message);
      }
    }
  }

  return (await serveFile(original, req, { cacheControl: CACHE_CONTROL })) ?? notFound();
}
