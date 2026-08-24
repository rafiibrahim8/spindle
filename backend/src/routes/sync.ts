import fs from 'node:fs';
import { getDb } from '../db/init.ts';
import { fail, json } from '../http/respond.ts';
import { readJson } from '../http/wrap.ts';
import { createSyncJob, getActiveJobId, getJob } from '../services/sync.ts';
import type { SyncEvent } from '../types.ts';

export async function startSync(req: Request): Promise<Response> {
  const body = await readJson(req);
  const musicRoot = String(body?.musicRoot ?? '').trim();
  if (!musicRoot) return fail('musicRoot is required', 400);

  // Reject bad paths up front, before a job is created — a typo'd root
  // shouldn't spin up a sync that immediately errors (or worse, clobber the
  // saved music_root setting).
  let isDir = false;
  try { isDir = fs.statSync(musicRoot).isDirectory(); } catch { /* missing */ }
  if (!isDir) return fail(`musicRoot is not a directory: ${musicRoot}`, 400);

  // Only one sync at a time: concurrent jobs interleave via the event-loop
  // yields and collide on the tracks.file_path UNIQUE constraint.
  const activeJobId = getActiveJobId();
  if (activeJobId) return json({ error: 'Sync already running', jobId: activeJobId }, 409);

  // Opt-in full re-read; ordinary syncs skip unchanged files by design.
  const force = body?.force === true;
  return json({ jobId: createSyncJob(musicRoot, force) });
}

export function syncStatus(): Response {
  const db = getDb();
  const root = db.query('SELECT value FROM settings WHERE key = ?')
    .get('music_root') as { value: string } | null;
  const count = db.query('SELECT COUNT(*) AS n FROM tracks').get() as { n: number };

  // Whether the stored music_root actually points at a real directory on this
  // machine. Lets the frontend distinguish "happy re-sync" from "DB moved here
  // from a different box and now points at a path that doesn't exist".
  const musicRootExists = root?.value
    ? (() => {
        try { return fs.statSync(root.value).isDirectory(); }
        catch { return false; }
      })()
    : false;

  return json({
    musicRoot: root?.value ?? null,
    musicRootExists,
    trackCount: count.n,
    activeJobId: getActiveJobId()
  });
}

/**
 * Server-sent progress for one job.
 *
 * The job publishes through an EventEmitter, so the stream bridges the two:
 * buffered events are replayed for a client that connected late, then live
 * events are forwarded until a terminal one arrives. `req.signal` is how a
 * disconnect is observed; without unsubscribing there, a client that navigates
 * away mid-sync would leak a listener for the rest of the run.
 */
export function syncProgress(req: Request & { params: { jobId: string } }, server: Bun.Server<undefined>): Response {
  const job = getJob(req.params.jobId);
  if (!job) return fail('Unknown sync job', 404);

  // A sync over a large library outlives any idle timeout.
  server.timeout(req, 0);

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: SyncEvent | unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          return false;   // client already gone
        }
        return true;
      };

      // Replay anything accumulated before this client connected.
      for (const event of job.events) send(event);
      if (job.status !== 'running') {
        controller.close();
        return;
      }

      const onEvent = (event: unknown) => {
        const delivered = send(event);
        const terminal = typeof event === 'object' && event && (event as { type?: string }).type !== 'progress';
        if (!delivered || terminal) {
          job.emitter.off('event', onEvent);
          try { controller.close(); } catch { /* already closed */ }
        }
      };
      job.emitter.on('event', onEvent);

      req.signal.addEventListener('abort', () => {
        job.emitter.off('event', onEvent);
        try { controller.close(); } catch { /* already closed */ }
      });
    }
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
