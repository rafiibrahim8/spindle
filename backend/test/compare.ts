/**
 * Diff two capture files produced by capture.ts.
 *
 * Used to prove the Bun rewrite serves the same API as the Express baseline,
 * and to prove the harness itself is deterministic (capture Express twice, diff
 * → must be empty).
 */

export interface Diff {
  step: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

/** Image bytes are re-encoded by a different library; only geometry is contract. */
const BYTE_EXACT_EXEMPT = (step: string) => step.startsWith('art:');

/**
 * Express stamps weak ETags on JSON responses via its own hashing; the rewrite
 * is not required to reproduce those byte-for-byte. Presence is not asserted
 * either, because dropping API-level ETags is an accepted difference.
 */
const IGNORED_HEADERS = new Set(['etag']);

function walk(prefix: string, expected: unknown, actual: unknown, out: Diff[], step: string): void {
  if (Object.is(expected, actual)) return;

  const bothObjects = expected && actual && typeof expected === 'object' && typeof actual === 'object';
  if (!bothObjects) {
    out.push({ step, field: prefix, expected, actual });
    return;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push({ step, field: prefix, expected: Array.isArray(expected) ? 'array' : 'object',
               actual: Array.isArray(actual) ? 'array' : 'object' });
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ step, field: `${prefix}.length`, expected: expected.length, actual: actual.length });
      return;
    }
    expected.forEach((v, i) => walk(`${prefix}[${i}]`, v, actual[i], out, step));
    return;
  }
  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
    walk(prefix ? `${prefix}.${k}` : k, e[k], a[k], out, step);
  }
}

export function compare(baseline: any, candidate: any): Diff[] {
  const out: Diff[] = [];
  const byName = (c: any) => new Map<string, any>(c.records.map((r: any) => [r.name, r]));
  const bl = byName(baseline);
  const cd = byName(candidate);

  for (const [name, b] of bl) {
    const c = cd.get(name);
    if (!c) { out.push({ step: name, field: '<step>', expected: 'present', actual: 'missing' }); continue; }

    if (b.status !== c.status) out.push({ step: name, field: 'status', expected: b.status, actual: c.status });

    for (const h of new Set([...Object.keys(b.headers ?? {}), ...Object.keys(c.headers ?? {})])) {
      if (IGNORED_HEADERS.has(h)) continue;
      const bv = b.headers?.[h], cv = c.headers?.[h];
      if (bv !== cv) out.push({ step: name, field: `header.${h}`, expected: bv ?? '<absent>', actual: cv ?? '<absent>' });
    }

    if ('json' in b || 'json' in c) walk('json', b.json, c.json, out, name);
    if ('text' in b || 'text' in c) walk('text', b.text, c.text, out, name);

    if (b.binary || c.binary) {
      const bb = b.binary ?? {}, cb = c.binary ?? {};
      walk('binary.image', bb.image, cb.image, out, name);
      if (!BYTE_EXACT_EXEMPT(name)) {
        if (bb.bytes !== cb.bytes) out.push({ step: name, field: 'binary.bytes', expected: bb.bytes, actual: cb.bytes });
        if (bb.sha256 !== cb.sha256) out.push({ step: name, field: 'binary.sha256', expected: bb.sha256, actual: cb.sha256 });
      }
    }
  }
  for (const name of cd.keys()) {
    if (!bl.has(name)) out.push({ step: name, field: '<step>', expected: 'absent', actual: 'unexpected' });
  }
  return out;
}

export function formatDiffs(diffs: Diff[]): string {
  if (!diffs.length) return 'no differences';
  const byStep = new Map<string, Diff[]>();
  for (const d of diffs) {
    if (!byStep.has(d.step)) byStep.set(d.step, []);
    byStep.get(d.step)!.push(d);
  }
  const lines: string[] = [];
  for (const [step, ds] of byStep) {
    lines.push(`  ${step}`);
    for (const d of ds.slice(0, 8)) {
      lines.push(`    ${d.field}: expected ${JSON.stringify(d.expected)?.slice(0, 90)} · got ${JSON.stringify(d.actual)?.slice(0, 90)}`);
    }
    if (ds.length > 8) lines.push(`    …and ${ds.length - 8} more in this step`);
  }
  return lines.join('\n');
}
