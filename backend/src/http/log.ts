/**
 * One line per request:
 *
 *   GET /api/tracks 200 1.284 ms - 4519
 *
 * Only the status is coloured — by class, so a sweep of the log shows failures
 * without reading them — and the length is `-` when the response has none.
 */
const RESET = '\x1b[0m';

function statusColour(status: number): string {
  if (status >= 500) return '\x1b[31m';   // red
  if (status >= 400) return '\x1b[33m';   // yellow
  if (status >= 300) return '\x1b[36m';   // cyan
  if (status >= 200) return '\x1b[32m';   // green
  return RESET;
}

export function logRequest(method: string, url: string, status: number, durationMs: number, length: string | null): void {
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
  const colour = statusColour(status);
  console.log(
    `${method} ${path} ${colour}${status}${RESET} ${durationMs.toFixed(3)} ms - ${length ?? '-'}`
  );
}
