import path from 'node:path';
import { getDb } from '../db/init.ts';
import { fail } from '../http/respond.ts';

/**
 * Audio streaming, with range handling done by hand.
 *
 * Bun applies automatic range handling to any file-backed response, but it is
 * not sufficient here, in four measured ways: it ignores `If-Range`, so a client
 * resuming a partial download whose file has changed gets fresh bytes spliced
 * onto its stale copy; it ignores `If-None-Match`, answering 200 where a 304 is
 * due; it answers a multi-range request with the whole body; and it treats a
 * malformed `bytes=-` as a request for everything rather than a 416.
 *
 * Setting `Content-Range` ourselves suppresses that layer, so every 206 and 416
 * below takes effect as written.
 */
const MIME: Record<string, string> = {
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.flac': 'audio/flac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav':  'audio/wav',
  '.wma':  'audio/x-ms-wma',
  '.aiff': 'audio/aiff'
};

export async function streamTrack(req: Request & { params: { id: string } }): Promise<Response> {
  const row = getDb().query('SELECT file_path FROM tracks WHERE id = ?')
    .get(Number(req.params.id)) as { file_path: string } | null;
  if (!row) return fail('Track not found', 404);

  const file = Bun.file(row.file_path);
  if (!(await file.exists())) return fail('File missing on disk; re-sync required', 410);

  const total = file.size;
  const contentType = MIME[path.extname(row.file_path).toLowerCase()] || 'application/octet-stream';

  // Cacheable responses let the browser reuse preloaded/buffered bytes instead
  // of re-fetching on every seek or element swap. The ETag is derived from
  // size+mtime, so a re-synced file invalidates immediately.
  const etag = `"${total}-${Math.floor(file.lastModified)}"`;
  const lastModified = new Date(file.lastModified).toUTCString();
  const common = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: etag,
    'Last-Modified': lastModified
  };

  if (req.headers.get('if-none-match') === etag) {
    // 304 must resend validators/caching headers so the cached entry's
    // freshness lifetime is refreshed (RFC 9110 §15.4.5).
    return new Response(null, {
      status: 304,
      headers: { 'Cache-Control': common['Cache-Control'], ETag: etag, 'Last-Modified': lastModified }
    });
  }

  const range = req.headers.get('range');
  if (!range) {
    return new Response(file, { headers: { ...common, 'Content-Length': String(total) } });
  }

  // Honour If-Range: when the validator no longer matches, ranges against the
  // client's stale copy would splice mismatched bytes — send the whole file.
  const ifRange = req.headers.get('if-range');
  if (ifRange && ifRange !== etag && ifRange !== lastModified) {
    return fullBodyDespiteRange(file, common);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match || (!match[1] && !match[2])) return unsatisfiable(total);

  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffix range (bytes=-N): the LAST N bytes of the file.
    start = Math.max(0, total - parseInt(match[2], 10));
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
  }
  if (start > end || start >= total) return unsatisfiable(total);

  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...common,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    }
  });
}

/**
 * 416 carries only the unsatisfied-range indicator. The representation headers
 * are deliberately omitted, matching what this endpoint has always sent: the
 * response describes the *request's* failure, not the resource.
 */
function unsatisfiable(total: number): Response {
  return new Response(null, {
    status: 416,
    headers: { 'Content-Range': `bytes */${total}` }
  });
}

/**
 * Serve the whole file even though the request carried a Range header.
 *
 * A file-backed body would be converted to a 206 by Bun's automatic range
 * handling, and the only header that suppresses it — `Content-Range` — is
 * forbidden on a 200 by RFC 9110 §14.4. Pumping the file through a stream
 * bypasses that layer at the cost of chunked transfer encoding, so this one
 * response has no `Content-Length`. It is reached only when a client resumes a
 * partial download whose validator has since changed.
 */
function fullBodyDespiteRange(file: Bun.BunFile, common: Record<string, string>): Response {
  const reader = file.stream().getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel() { void reader.cancel(); }
  });
  return new Response(body, { headers: common });
}
