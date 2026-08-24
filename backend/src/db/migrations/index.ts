/**
 * The migration set, embedded at build time.
 *
 * The old runner read this directory with `readdirSync`, which cannot work once
 * the backend ships as a bundle: `dist/index.js` is the only file in the image.
 * Importing each file as text inlines it into the bundle instead, and keeps the
 * ordering explicit and type-checked rather than derived from filenames.
 *
 * To add a migration: create `00N_name.sql`, import it, and append it here with
 * its version. Versions must ascend and must never be renumbered — they are
 * compared against `PRAGMA user_version` in the live database.
 */
import m001 from './001_initial.sql' with { type: 'text' };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_initial.sql', sql: m001 }
];
