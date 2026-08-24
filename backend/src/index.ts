import fs from 'node:fs';
import path from 'node:path';
import { initDb } from './db/init.ts';
import { ART_CACHE_DIR, PORT, STATIC_DIR } from './env.ts';
import { notFound } from './http/respond.ts';
import { resolveWithin, serveFile } from './http/static.ts';
import { wrapRoutes } from './http/wrap.ts';

/** Art filenames are content hashes, so a given URL's bytes can never change. */
const ART_CACHE_CONTROL = 'public, max-age=2592000, immutable';
/** Vite's asset names are content-hashed too, though less aggressively cached. */
const ASSET_CACHE_CONTROL = 'public, max-age=604800';
/** The shell is the one file whose contents change under a stable URL. */
const SHELL_CACHE_CONTROL = 'public, max-age=0';

fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

/**
 * Cached cover art. Downscaled `?w=` renditions are handled ahead of this in
 * routes/art.ts; anything reaching here is served at full size.
 */
async function serveArt(req: Request): Promise<Response> {
  const rel = new URL(req.url).pathname.slice('/art'.length);
  const target = resolveWithin(ART_CACHE_DIR, rel);
  if (!target) return notFound();
  return (await serveFile(target, req, { cacheControl: ART_CACHE_CONTROL })) ?? notFound();
}

/**
 * The built SPA, when one is configured.
 *
 * A path that matches no asset returns `index.html` rather than a 404, so the
 * client-side router can handle deep links — and, as a side effect that the
 * captured baseline confirms, a request for a missing hashed asset also returns
 * the shell rather than a 404.
 */
async function serveSpa(req: Request): Promise<Response> {
  if (!STATIC_DIR) return notFound();
  const { pathname } = new URL(req.url);

  const target = resolveWithin(STATIC_DIR, pathname);
  if (target) {
    const asset = await serveFile(target, req, { cacheControl: ASSET_CACHE_CONTROL });
    if (asset) return asset;
  }
  const shell = await serveFile(path.join(STATIC_DIR, 'index.html'), req, { cacheControl: SHELL_CACHE_CONTROL });
  return shell ?? notFound();
}

initDb();

const server = Bun.serve({
  port: PORT,
  // express.json({ limit: '1mb' }) — nothing here accepts an upload.
  maxRequestBodySize: 1024 * 1024,
  routes: wrapRoutes({
    '/art/*': serveArt,
    // Unknown API paths must stay JSON: serving the SPA shell here would mask
    // typos and break clients that expect to parse the body.
    '/api/*': () => notFound(),
    '/*': serveSpa
  }),
  error(err: Error) {
    console.error(err.stack || err);
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
});

console.log(`🎵 Spindle running on http://localhost:${server.port}`);

// Without this the container would rely on SIGKILL after the stop timeout,
// leaving the WAL un-checkpointed on every restart.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
}
