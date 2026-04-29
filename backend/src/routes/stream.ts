import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/init.js';

const router = express.Router();

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

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': total,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(row.file_path).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
  if (start > end || start >= total) {
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${total}`
  });
  fs.createReadStream(row.file_path, { start, end }).pipe(res);
});

export default router;
