/**
 * Capture a running server and diff it against the committed baseline.
 *
 *   bun test/verify.ts http://localhost:3199 [baselineFile]
 *
 * Exits non-zero on any difference, so it doubles as a CI gate.
 */
import { compare, formatDiffs } from './compare.ts';

const BASE = process.argv[2];
const BASELINE = process.argv[3] ?? `${import.meta.dir}/fixtures/express-baseline.json`;
if (!BASE) { console.error('usage: bun test/verify.ts <baseUrl> [baselineFile]'); process.exit(2); }

const tmp = `/tmp/spindle-verify-${process.pid}.json`;
const proc = Bun.spawnSync(['bun', `${import.meta.dir}/capture.ts`, BASE, tmp], { stdout: 'inherit', stderr: 'inherit' });
if (proc.exitCode !== 0) { console.error('capture failed'); process.exit(1); }

const baseline = await Bun.file(BASELINE).json();
const candidate = await Bun.file(tmp).json();
const diffs = compare(baseline, candidate);

if (!diffs.length) {
  console.log(`✅ ${candidate.records.length} steps match ${BASELINE.replace(/.*\//, '')}`);
  process.exit(0);
}
const steps = new Set(diffs.map((d) => d.step));
console.log(`❌ ${diffs.length} difference(s) across ${steps.size} step(s):\n${formatDiffs(diffs)}`);
process.exit(1);
