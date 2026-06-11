import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_ROOT, 'db', 'music.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db: DB | null = null;

export function getDb(): DB {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// better-sqlite3 does not cache prepared statements, so hot loops that call
// db.prepare() per row pay the parse/plan cost every time. Memoize by SQL
// string, keyed per db instance so a reopened handle never reuses stale
// statements.
const stmtCache = new WeakMap<DB, Map<string, Statement>>();

export function prepared(handle: DB, sql: string): Statement {
  let perDb = stmtCache.get(handle);
  if (!perDb) {
    perDb = new Map();
    stmtCache.set(handle, perDb);
  }
  let stmt = perDb.get(sql);
  if (!stmt) {
    stmt = handle.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}

export function initDb(): void {
  const handle = getDb();
  handle.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  runMigrations(handle);
  seedSmartPlaylists(handle);
  console.log('✅ Database initialized');
}

/**
 * Minimal migration runner: numbered .sql files in db/migrations are applied
 * in order when their number exceeds PRAGMA user_version, each inside a
 * transaction. 001_initial.sql is the no-op baseline (schema.sql above is
 * idempotent and creates everything for fresh DBs).
 */
function runMigrations(handle: DB): void {
  const current = Number(handle.pragma('user_version', { simple: true }));
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    handle.transaction(() => {
      handle.exec(sql);
      handle.pragma(`user_version = ${version}`);
    })();
    console.log(`✅ Applied migration ${file}`);
  }
}

function seedSmartPlaylists(handle: DB): void {
  const insert = handle.prepare(`
    INSERT OR IGNORE INTO playlists(name, read_only, smart_key)
    VALUES (?, 1, ?)
  `);
  insert.run('Top 25 Most Played', 'most-played');
  insert.run('Recently Added',     'recently-added');
  insert.run('Never Played',       'never-played');
}
