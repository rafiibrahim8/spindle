/**
 * Response helpers.
 *
 * `Response.json()` would serve, but it emits `application/json;charset=utf-8`
 * where Express emitted `application/json; charset=utf-8`. The two are
 * equivalent under RFC 9110, and the contract comparison normalises them; the
 * header is still written out in full here so the wire format matches what the
 * frontend has always received.
 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
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
