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
  const jobId = createSyncJob(musicRoot);
  res.json({ jobId });
});

router.get('/status', (_req, res) => {
  const db = getDb();
  const root = db
    .prepare<[string]>('SELECT value FROM settings WHERE key = ?')
    .get('music_root') as { value: string } | undefined;
  const count = db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number };
  res.json({
    musicRoot: root?.value ?? null,
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
