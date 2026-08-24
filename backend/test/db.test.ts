/**
 * The rewritten db/init.ts: schema bootstrap, migration runner, smart-playlist
 * seeding — exercised on a scratch database and on a copy of the real one.
 */
import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

// env.ts snapshots process.env at import time, so this must precede the import.
const ROOT = `/tmp/spindle-db-test-${process.pid}`;
process.env.DATA_ROOT = ROOT;
const { initDb, getDb, closeDb } = await import('../src/db/init.ts');
const { DB_PATH } = await import('../src/env.ts');

const PRISTINE = `${import.meta.dir}/../../_DATA/db/music.db`;

beforeAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });
afterAll(() => { closeDb(); fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('fresh database', () => {
  test('initDb creates the schema, sets user_version and enables WAL + foreign keys', () => {
    initDb();
    const db = getDb();
    const q = <T>(sql: string) => db.query(sql).get() as T;

    expect(q<{ n: number }>("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").n).toBe(11);
    expect(q<{ user_version: number }>('PRAGMA user_version').user_version).toBe(1);
    expect(q<{ journal_mode: string }>('PRAGMA journal_mode').journal_mode).toBe('wal');
    expect(q<{ foreign_keys: number }>('PRAGMA foreign_keys').foreign_keys).toBe(1);
  });

  test('the three read-only smart playlists are seeded', () => {
    const rows = getDb().query('SELECT name, smart_key, read_only FROM playlists ORDER BY id').all();
    expect(rows).toEqual([
      { name: 'Top 25 Most Played', smart_key: 'most-played',    read_only: 1 },
      { name: 'Recently Added',     smart_key: 'recently-added', read_only: 1 },
      { name: 'Never Played',       smart_key: 'never-played',   read_only: 1 }
    ]);
  });

  test('initDb is idempotent — a second run neither throws nor duplicates seeds', () => {
    expect(() => initDb()).not.toThrow();
    expect((getDb().query('SELECT COUNT(*) n FROM playlists').get() as { n: number }).n).toBe(3);
  });
});

describe('existing database', () => {
  test('an already-migrated database is left at its current user_version', () => {
    if (!fs.existsSync(PRISTINE)) return;   // library not present on this machine
    closeDb();
    fs.copyFileSync(PRISTINE, DB_PATH);
    fs.rmSync(`${DB_PATH}-wal`, { force: true });
    fs.rmSync(`${DB_PATH}-shm`, { force: true });

    initDb();
    const db = getDb();
    expect((db.query('SELECT COUNT(*) n FROM tracks').get() as { n: number }).n).toBeGreaterThan(0);
    // No migration beyond the baseline exists, so this must not advance.
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    // Seeding must not duplicate the smart playlists that are already there.
    expect((db.query("SELECT COUNT(*) n FROM playlists WHERE smart_key = 'most-played'").get() as { n: number }).n).toBe(1);
  });
});

describe('migration runner', () => {
  // Why the runner needs hasStatements(): better-sqlite3's exec() accepted a
  // comment-only script as a no-op, and 001_initial.sql is exactly that.
  test('bun:sqlite rejects a comment-only script, unlike better-sqlite3 exec()', () => {
    const db = new Database(':memory:', { strict: true });
    expect(() => db.run('-- just a comment\n')).toThrow(/no valid SQL statement/i);
  });

  test('the baseline migration really is comment-only', async () => {
    const sql = await Bun.file(`${import.meta.dir}/../src/db/migrations/001_initial.sql`).text();
    const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
    expect(stripped).toBe('');
  });

  test('migration versions ascend and are unique', async () => {
    const { MIGRATIONS } = await import('../src/db/migrations/index.ts');
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});
