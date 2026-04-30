import Database, { type Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_ROOT, 'db', 'music.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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

export function initDb(): void {
  const handle = getDb();
  handle.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  seedSmartPlaylists(handle);
  console.log('✅ Database initialized');
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
