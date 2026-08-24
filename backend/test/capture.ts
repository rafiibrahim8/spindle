/**
 * CLI wrapper around captureAll(): record a running server to a fixture file.
 *
 *   bun test/capture.ts http://localhost:3199 test/fixtures/express-baseline.json
 *
 * Set FULL=1 to keep whole arrays instead of digesting them, when a digest
 * mismatch needs investigating.
 */
import { captureAll } from './capture-lib.ts';

const BASE = process.argv[2];
const OUT = process.argv[3];
if (!BASE || !OUT) {
  console.error('usage: bun test/capture.ts <baseUrl> <outFile>');
  process.exit(2);
}

const result = await captureAll(BASE);
const d = result.discovered;
console.log(`discovered: track=${d.trackId} album=${d.albumId} artist=${d.artistId} ` +
            `smartPlaylist=${d.smartPlaylistId} genre="${d.genre}" art=${d.artFile.slice(0, 12)}…`);

await Bun.write(OUT, JSON.stringify(result, null, 2) + '\n');
const codes = result.records.reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
console.log(`captured ${result.records.length} steps -> ${OUT}`);
console.log(`status codes: ${Object.entries(codes).sort().map(([k, v]) => `${k}×${v}`).join('  ')}`);
