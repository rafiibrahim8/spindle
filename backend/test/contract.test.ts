/**
 * The API contract: boot the rewritten server, replay all 106 steps, and diff
 * against the baseline recorded from the Express app.
 *
 * Needs the real database and music library to be present, since the baseline
 * was captured against them; skipped otherwise. The server runs as a
 * subprocess against a private copy of the database, because the spec mutates
 * state — it likes a track, creates a playlist, records plays and writes
 * settings — and every run must start from the same rows.
 */
import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import { captureAll } from './capture-lib.ts';
import { compare, formatDiffs } from './compare.ts';

const REPO = `${import.meta.dir}/../..`;
const SOURCE_DB = `${REPO}/_DATA/db/music.db`;
const SOURCE_ART = `${REPO}/_DATA/art`;
const BASELINE = `${import.meta.dir}/fixtures/express-baseline.json`;

const ROOT = `/tmp/spindle-contract-${process.pid}`;
const PORT = 3300 + (process.pid % 200);
const available = fs.existsSync(SOURCE_DB) && fs.existsSync(SOURCE_ART);

let server: Bun.Subprocess | null = null;

beforeAll(async () => {
  if (!available) return;
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${ROOT}/data/db`, { recursive: true });
  fs.mkdirSync(`${ROOT}/spa/assets`, { recursive: true });

  // Copy the WAL too: the live database keeps uncommitted pages there, and
  // taking music.db alone silently loses rows.
  fs.copyFileSync(SOURCE_DB, `${ROOT}/data/db/music.db`);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(SOURCE_DB + suffix)) fs.copyFileSync(SOURCE_DB + suffix, `${ROOT}/data/db/music.db${suffix}`);
  }
  // Art is read-only for this suite, so a symlink avoids copying 42 MB.
  fs.symlinkSync(SOURCE_ART, `${ROOT}/data/art`);

  // The baseline was captured production-shaped: with a static dir present,
  // unknown /api and /art paths return JSON rather than the SPA shell.
  fs.writeFileSync(`${ROOT}/spa/index.html`,
    '<!doctype html>\n<html><head><title>Spindle</title></head><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>\n');
  fs.writeFileSync(`${ROOT}/spa/assets/app-abc123.js`, 'console.log("stub bundle");\n');
  fs.writeFileSync(`${ROOT}/spa/favicon.svg`,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>\n');

  server = Bun.spawn(['bun', `${import.meta.dir}/../src/index.ts`], {
    env: {
      ...process.env,
      DATA_ROOT: `${ROOT}/data`,
      PORT: String(PORT),
      FRONTEND_URL: 'http://localhost:5174',
      SPINDLE_FRONTEND_STATIC_DIR: `${ROOT}/spa`
    },
    stdout: 'ignore',
    stderr: 'pipe'
  });

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/sync/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`server did not start: ${await new Response(server.stderr as ReadableStream).text()}`);
});

afterAll(() => {
  server?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!available)('API contract vs the Express baseline', () => {
  test('every recorded step matches', async () => {
    const baseline = await Bun.file(BASELINE).json();
    const candidate = await captureAll(`http://localhost:${PORT}`);

    expect(candidate.records.length).toBe(baseline.records.length);

    const diffs = compare(baseline, candidate);
    if (diffs.length) {
      const steps = new Set(diffs.map((d) => d.step));
      throw new Error(`${diffs.length} difference(s) across ${steps.size} step(s):\n${formatDiffs(diffs)}`);
    }
    expect(diffs).toEqual([]);
  }, 180_000);
});
