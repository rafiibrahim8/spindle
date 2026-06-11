import fs from 'node:fs';
import express from 'express';
import { getDb } from '../db/init.js';
import { createSyncJob, getActiveJobId, getJob } from '../services/sync.js';

const router = express.Router();

router.post('/start', (req, res) => {
  const musicRoot = String(req.body?.musicRoot || '').trim();
  if (!musicRoot) {
    res.status(400).json({ error: 'musicRoot is required' });
    return;
  }
  // Reject bad paths up front, before a job is created — a typo'd root
  // shouldn't spin up a sync that immediately errors (or worse, clobber the
  // saved music_root setting).
  let isDir = false;
  try { isDir = fs.statSync(musicRoot).isDirectory(); } catch { /* missing */ }
  if (!isDir) {
    res.status(400).json({ error: `musicRoot is not a directory: ${musicRoot}` });
    return;
  }
  // Only one sync at a time: concurrent jobs interleave via the event-loop
  // yields and collide on the tracks.file_path UNIQUE constraint.
  const activeJobId = getActiveJobId();
  if (activeJobId) {
    res.status(409).json({ error: 'Sync already running', jobId: activeJobId });
    return;
  }
  const jobId = createSyncJob(musicRoot);
  res.json({ jobId });
});

router.get('/status', (_req, res) => {
  const db = getDb();
  const root = db
    .prepare<[string]>('SELECT value FROM settings WHERE key = ?')
    .get('music_root') as { value: string } | undefined;
  const count = db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number };
  // Whether the stored music_root actually points at a real directory on this
  // machine. Lets the frontend distinguish "happy re-sync" from "DB moved
  // here from a different box and now points at a path that doesn't exist".
  const musicRootExists = root?.value
    ? (() => {
        try { return fs.statSync(root.value).isDirectory(); }
        catch { return false; }
      })()
    : false;
  res.json({
    musicRoot: root?.value ?? null,
    musicRootExists,
    trackCount: count.n,
    activeJobId: getActiveJobId()
  });
});

router.get('/progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown sync job' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  // Replay any events accumulated before the client connected.
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (job.status !== 'running') {
    res.end();
    return;
  }

  const onEvent = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof event === 'object' && event && (event as { type?: string }).type !== 'progress') {
      res.end();
    }
  };
  job.emitter.on('event', onEvent);

  req.on('close', () => {
    job.emitter.off('event', onEvent);
  });
});

export default router;
