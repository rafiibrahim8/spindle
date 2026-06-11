import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { getDb } from '../db/init.js';

const router = express.Router();

// pipeline() (unlike .pipe()) destroys the file stream when either side
// errors or the client disconnects, so a vanished file or an aborted request
// can't crash the process or leak an fd. Premature closes are routine
// (seeking, tab close) and not worth logging.
function sendStream(readStream: fs.ReadStream, res: express.Response): void {
  pipeline(readStream, res, (err) => {
    if (!err) return;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || (err as { message?: string }).message === 'aborted') return;
    console.warn('[stream] pipeline error:', err.message);
  });
}

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

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare<[number]>('SELECT file_path FROM tracks WHERE id = ?')
    .get(id) as { file_path: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.file_path);
  } catch {
    res.status(410).json({ error: 'File missing on disk; re-sync required' });
    return;
  }

  const total = stat.size;
  const ext = path.extname(row.file_path).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  // Cacheable responses let the browser reuse preloaded/buffered bytes
  // instead of re-fetching on every seek or element swap. The ETag is
  // derived from size+mtime, so a re-synced file invalidates immediately.
  const etag = `"${total}-${Math.floor(stat.mtimeMs)}"`;
  const lastModified = stat.mtime.toUTCString();
  const commonHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: etag,
    'Last-Modified': lastModified
  };

  if (req.headers['if-none-match'] === etag) {
    // 304 must resend validators/caching headers so the cached entry's
    // freshness lifetime is refreshed (RFC 9110 §15.4.5).
    res.writeHead(304, {
      'Cache-Control': commonHeaders['Cache-Control'],
      ETag: etag,
      'Last-Modified': lastModified
    });
    res.end();
    return;
  }

  // Honor If-Range: when the validator no longer matches, ranges against the
  // client's stale copy would splice mismatched bytes — send the full file.
  const ifRange = req.headers['if-range'];
  const rangeIsValid = !ifRange || ifRange === etag || ifRange === lastModified;

  const range = req.headers.range;
  if (!range || !rangeIsValid) {
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': total
    });
    sendStream(fs.createReadStream(row.file_path), res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffix range (bytes=-N): the LAST N bytes of the file.
    const suffixLength = parseInt(match[2], 10);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
  }
  if (start > end || start >= total) {
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }

  res.writeHead(206, {
    ...commonHeaders,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`
  });
  sendStream(fs.createReadStream(row.file_path, { start, end }), res);
});

export default router;
