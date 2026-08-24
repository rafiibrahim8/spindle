/**
 * Guards on the bun:sqlite behaviours this codebase relies on.
 *
 * These are less tests of our own code than assertions about assumptions: if a
 * future Bun release changes any of them, the sync pipeline breaks in ways that
 * are invisible at the API surface. The parameter-binding pair below is the one
 * that matters most — it is why every Database is opened with `strict: true`.
 */
import { expect, test, describe } from 'bun:test';
import { Database } from 'bun:sqlite';

const SCHEMA = await Bun.file(`${import.meta.dir}/../src/db/schema.sql`).text();

function fresh(strict = true): Database {
  const db = new Database(':memory:', { strict });
  db.run(SCHEMA);
  return db;
}

describe('named parameter binding', () => {
  // The whole codebase binds plain objects to @name placeholders. Without
  // strict mode that silently matches nothing — no error, no row — so this
  // pins the reason strict mode is mandatory rather than preferred.
  test('non-strict mode silently fails to bind bare keys', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT)');
    db.run("INSERT INTO a(name) VALUES('X')");
    expect(db.query('SELECT id FROM a WHERE name = @n').get({ n: 'X' } as never)).toBeNull();
    expect(db.query('SELECT id FROM a WHERE name = @n').get({ '@n': 'X' } as never)).toEqual({ id: 1 });
  });

  test('strict mode binds bare keys', () => {
    const db = fresh();
    db.run("INSERT INTO artists(name) VALUES('X')");
    expect(db.query('SELECT id FROM artists WHERE name = @n').get({ n: 'X' })).toEqual({ id: 1 });
  });

  test('strict mode accepts null values in an upsert', () => {
    const db = fresh();
    db.run("INSERT INTO artists(name) VALUES('A')");
    db.run("INSERT INTO tracks(file_path, file_hash, file_size, file_mtime) VALUES('/x', 'h', 1, 1)");
    const stmt = db.query(`
      INSERT INTO lyrics(track_id, synced_lrc, unsynced_text)
      VALUES (@trackId, @syncedLrc, @unsyncedText)
      ON CONFLICT(track_id) DO UPDATE SET
        synced_lrc = excluded.synced_lrc, unsynced_text = excluded.unsynced_text
    `);
    stmt.run({ trackId: 1, syncedLrc: '[00:01.00]hi', unsyncedText: null });
    stmt.run({ trackId: 1, syncedLrc: null, unsyncedText: 'plain' });
    expect(db.query('SELECT * FROM lyrics WHERE track_id = 1').get())
      .toEqual({ track_id: 1, synced_lrc: null, unsynced_text: 'plain' });
  });
});

describe('result shapes', () => {
  // Row types across the codebase are declared `| null` because of this.
  test('.get() with no match returns null, not undefined', () => {
    const db = fresh();
    const row = db.query('SELECT id FROM artists WHERE name = ?').get('nobody');
    expect(row).toBeNull();
    expect(row).not.toBeUndefined();
  });

  test('lastInsertRowid is a number while safeIntegers is off', () => {
    const db = fresh();
    const res = db.query('INSERT INTO artists(name) VALUES(?)').run('A');
    expect(typeof res.lastInsertRowid).toBe('number');
    expect(res.changes).toBe(1);
  });

  test('.all() returns [] rather than null when nothing matches', () => {
    expect(fresh().query('SELECT id FROM artists WHERE name = ?').all('nobody')).toEqual([]);
  });
});

describe('schema and migrations', () => {
  test('run() executes the whole multi-statement schema.sql', () => {
    const tables = fresh().query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    expect(tables).toContain('tracks');
    expect(tables).toContain('play_stats');
    expect(tables).toContain('playlist_tracks');
    expect(tables).toContain('user_settings');
  });

  test('schema.sql is idempotent — running it twice is a no-op', () => {
    const db = fresh();
    expect(() => db.run(SCHEMA)).not.toThrow();
  });

  test('user_version round-trips through PRAGMA', () => {
    const db = fresh();
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
    db.run('PRAGMA user_version = 7');
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7);
  });
});

describe('transactions', () => {
  test('transaction() commits as a unit', () => {
    const db = fresh();
    const ins = db.query('INSERT INTO artists(name) VALUES(?)');
    db.transaction((names: string[]) => { for (const n of names) ins.run(n); })(['a', 'b', 'c']);
    expect((db.query('SELECT COUNT(*) n FROM artists').get() as { n: number }).n).toBe(3);
  });

  test('a throwing transaction rolls back', () => {
    const db = fresh();
    const ins = db.query('INSERT INTO artists(name) VALUES(?)');
    const txn = db.transaction(() => { ins.run('a'); throw new Error('boom'); });
    expect(() => txn()).toThrow('boom');
    expect((db.query('SELECT COUNT(*) n FROM artists').get() as { n: number }).n).toBe(0);
  });

  test('foreign_keys = ON is enforced once enabled', () => {
    const db = fresh();
    db.run('PRAGMA foreign_keys = ON');
    expect(() => db.run('INSERT INTO lyrics(track_id, synced_lrc) VALUES(4242, NULL)')).toThrow();
  });
});
