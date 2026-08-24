/**
 * Response helpers.
 *
 * The content type is written out rather than left to `Response.json()`, which
 * emits the parameter unspaced. Both spellings are equivalent under RFC 9110,
 * so this is only about keeping one form on the wire.
 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function json(data: unknown, status = 200, extraHeaders?: Bun.HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(data), { status, headers });
}

/** The error body shape every failing endpoint uses: `{ "error": "..." }`. */
export function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

export function notFound(message = 'Not found'): Response {
  return fail(message, 404);
}
