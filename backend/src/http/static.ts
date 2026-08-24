/**
 * Static file serving, replacing `express.static` and `res.sendFile`.
 *
 * Bun 1.4 can serve a directory natively with `routes: { '/x/*': { dir } }`,
 * and it handles ETag, Last-Modified, 304 and Range on its own — but its option
 * shape is `{ dir, statCache }` with no way to attach headers, and the two
 * things served here both depend on `Cache-Control`: art filenames are content
 * hashes and want a year of immutable caching, while `index.html` must not be
 * cached at all. So the files are served by hand.
 */
import path from 'node:path';

export interface ServeOptions {
  cacheControl: string;
  /** Sent as-is; falls back to whatever Bun infers from the extension. */
  contentType?: string;
}

/**
 * Resolve a URL path inside a directory, refusing anything that escapes it.
 * Returns null for traversal attempts and for undecodable paths.
 */
export function resolveWithin(dir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;          // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const root = path.resolve(dir);
  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  // path.resolve collapses `..`, so a prefix check is sufficient. The trailing
  // separator prevents `/data-other` matching a `/data` root.
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Serve one file with validators and a caching policy, answering 304 when the
 * client's ETag still matches. Returns null when the file does not exist, so
 * callers can fall through (to a rendition, or to the SPA shell).
 */
export async function serveFile(absPath: string, req: Request, opts: ServeOptions): Promise<Response | null> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return null;

  const etag = `"${file.size}-${Math.floor(file.lastModified)}"`;
  const lastModified = new Date(file.lastModified).toUTCString();
  const headers = new Headers({
    'Cache-Control': opts.cacheControl,
    ETag: etag,
    'Last-Modified': lastModified,
    'Accept-Ranges': 'bytes'
  });
  if (opts.contentType) headers.set('Content-Type', opts.contentType);

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(file, { headers });
}
