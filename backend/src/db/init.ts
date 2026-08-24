import { Database, type Statement } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../env.ts';
import schemaSql from './schema.sql' with { type: 'text' };
import { MIGRATIONS } from './migrations/index.ts';

let db: Database | null = null;

/**
 * `strict: true` is not optional here. Under the default, binding a plain
 * object to an `@name` placeholder silently matches nothing — no error, no row
 * — and this codebase binds plain objects throughout the sync pipeline, so the
 * loose mode would write NULLs and pass every API-level test. See
 * test/sqlite.test.ts, which pins the behaviour.
 */
export function getDb(): Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH, { create: true, strict: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  }
  return db;
}

export function closeDb(): void {
  db?.close(false);
  db = null;
}

export function initDb(): void {
  const handle = getDb();
  // schema.sql is idempotent (CREATE ... IF NOT EXISTS throughout) and run on
  // every startup, so a fresh database needs no migration to become current.
  handle.run(schemaSql);
  runMigrations(handle);
  seedSmartPlaylists(handle);
  console.log('✅ Database initialized');
}

/**
 * Apply any migration whose version exceeds PRAGMA user_version, in order, each
 * inside a transaction. 001_initial.sql is the no-op baseline that establishes
 * user_version = 1.
 */
function runMigrations(handle: Database): void {
  const current = userVersion(handle);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    handle.transaction(() => {
      // A migration with nothing to execute is legitimate: 001_initial.sql is
      // a documentation-only baseline whose whole job is to establish
      // user_version = 1. run() rejects a script with no statements in it, so
      // the version bump has to happen without the run.
      if (hasStatements(migration.sql)) handle.run(migration.sql);
      // PRAGMA does not accept bound parameters, and the value is an integer
      // literal from this module, never from input.
      handle.run(`PRAGMA user_version = ${migration.version}`);
    })();
    console.log(`✅ Applied migration ${migration.name}`);
  }
}

/**
 * Whether a migration contains anything to execute once comments are removed.
 *
 * Deliberately biased towards "yes": a false positive merely lets run() raise
 * on a genuinely empty script, while a false negative would silently skip a
 * real migration and still bump user_version.
 */
function hasStatements(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/--[^\n]*/g, '')            // line comments
    .trim();
  return stripped.length > 0;
}

function userVersion(handle: Database): number {
  return (handle.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function seedSmartPlaylists(handle: Database): void {
  const insert = handle.query(`
    INSERT OR IGNORE INTO playlists(name, read_only, smart_key)
    VALUES (?, 1, ?)
  `);
  insert.run('Top 25 Most Played', 'most-played');
  insert.run('Recently Added',     'recently-added');
  insert.run('Never Played',       'never-played');
}

/**
 * Bind a statement once and reuse it.
 *
 * `db.query()` already caches compiled statements, but only about twenty of
 * them, and the sync pipeline uses a dozen distinct statements in its hot loop —
 * close enough to the cap to be worth not relying on. Callers that run inside a
 * loop should hold the statement in a module-level constant via this helper
 * rather than calling `db.query()` per row.
 */
export function prepared(handle: Database, sql: string): Statement {
  return handle.query(sql);
}
