/**
 * CORS, replacing the `cors` package.
 *
 * Mirrors what `cors({ origin: FRONTEND_URL })` emitted, which the captured
 * baseline pins down: every response carries `Vary: Origin` and a fixed
 * `Access-Control-Allow-Origin`, whether or not the request had an `Origin`
 * header — the allowed origin is configuration, not a reflection of the caller.
 */
import { FRONTEND_URL } from '../env.ts';

/** The package's default method list, echoed verbatim on preflight. */
const ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

export function applyCors(headers: Headers): void {
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Origin', FRONTEND_URL);
}

/**
 * Answer a preflight. 204 with no body, and `Access-Control-Request-Headers`
 * echoed back as `Access-Control-Allow-Headers` when the caller sent it.
 */
export function preflight(req: Request): Response {
  const headers = new Headers({
    Vary: 'Origin, Access-Control-Request-Headers',
    'Access-Control-Allow-Origin': FRONTEND_URL,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Content-Length': '0'
  });
  const requested = req.headers.get('access-control-request-headers');
  if (requested) headers.set('Access-Control-Allow-Headers', requested);
  return new Response(null, { status: 204, headers });
}
