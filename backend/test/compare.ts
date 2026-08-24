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
 * Header values that are equivalent under RFC 9110 but spelled differently by
 * Express and Bun. Matching Express's exact spelling would mean hand-setting
 * every content-type, so the comparison is normalised instead.
 *
 *   application/json; charset=utf-8   ==  application/json;charset=utf-8
 *   text/html; charset=UTF-8          ==  text/html;charset=utf-8
 *
 * Media-type parameters are whitespace-insensitive and `charset` values are
 * case-insensitive, so these differences are not observable by a client.
 */
/** RFC 9239 registered text/javascript and obsoleted application/javascript. */
const MEDIA_TYPE_ALIASES: Record<string, string> = {
  'application/javascript': 'text/javascript'
};

function normalizeContentType(value: string): string {
  const [rawType, ...params] = value.split(';');
  const type = MEDIA_TYPE_ALIASES[rawType.trim().toLowerCase()] ?? rawType;
  const normalizedParams = params
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return [type.trim().toLowerCase(), ...normalizedParams].join('; ');
}

/**
 * Express stamps a weak ETag on responses it generates itself, derived from its
 * own hashing. The rewrite is not required to reproduce those, so a weak
 * baseline ETag is not compared. A *strong* one is: `/api/stream` derives
 * `"<size>-<mtime>"` deliberately, and that is contract.
 */
function headerMatters(name: string, baselineValue: string | undefined): boolean {
  if (name === 'etag') return !(baselineValue ?? '').startsWith('W/');
  return true;
}

function headersEqual(name: string, a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (name === 'content-type') return normalizeContentType(a) === normalizeContentType(b);
  return false;
}

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

/**
 * Differences that are accepted rather than fixed, with the reason.
 *
 * `stream:if-range-stale` — when a client resumes a partial download whose
 * validator has changed, the whole file must be sent despite the Range header.
 * A file-backed body would be turned into a 206 by Bun's automatic range
 * handling, and the only header that suppresses it, `Content-Range`, is
 * forbidden on a 200 by RFC 9110 §14.4. Streaming the file bypasses that layer
 * but forces chunked transfer encoding, so this one response has no
 * `Content-Length`. The body is byte-identical either way.
 */
const ACCEPTED_DEVIATIONS = new Set(['stream:if-range-stale::header.content-length']);

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
      const bv = b.headers?.[h], cv = c.headers?.[h];
      if (!headerMatters(h, bv)) continue;
      // A bodiless response may or may not carry an explicit zero length:
      // Express writes `content-length: 0` on its 204/304s, Bun omits it.
      if (h === 'content-length' && (b.status === 204 || b.status === 304)
          && (bv ?? '0') === (cv ?? '0')) continue;
      if (ACCEPTED_DEVIATIONS.has(`${name}::header.${h}`)) continue;
      if (!headersEqual(h, bv, cv)) {
        out.push({ step: name, field: `header.${h}`, expected: bv ?? '<absent>', actual: cv ?? '<absent>' });
      }
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
