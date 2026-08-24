/**
 * The middleware stack, as a decorator over the route table.
 *
 * Express composed behaviour with `app.use`; Bun's routes are plain values, so
 * the equivalent is to wrap every handler once, here. Applying it centrally is
 * what stops a new route from quietly shipping without CORS headers or logging.
 *
 * Order matches the Express pipeline: the handler runs, its errors become the
 * JSON error shape, CORS headers go on whatever response results, and the
 * request is logged last with the final status.
 */
import { applyCors, preflight } from './cors.ts';
import { logRequest } from './log.ts';
import { fail } from './respond.ts';

type Handler = (req: any, server: any) => Response | Promise<Response>;
type RouteValue = Handler | Record<string, Handler>;

/** Mirrors the old errorHandler: honour a thrown statusCode, else 500. */
function errorResponse(err: unknown): Response {
  console.error((err as Error)?.stack || err);
  const status = (err as { statusCode?: number })?.statusCode ?? 500;
  return fail((err as Error)?.message || 'Internal server error', status);
}

function decorate(handler: Handler): Handler {
  return async (req, server) => {
    const started = performance.now();
    let res: Response;
    const isPreflight = req.method === 'OPTIONS';
    try {
      // `cors` answered preflights before any route ran, so OPTIONS never
      // reaches a handler here either.
      res = isPreflight ? preflight(req) : await handler(req, server);
    } catch (err) {
      res = errorResponse(err);
    }
    // preflight() already emits the full CORS set, including a Vary that names
    // Access-Control-Request-Headers; re-applying the generic headers here
    // would overwrite that with a bare "Origin".
    if (!isPreflight) applyCors(res.headers);
    logRequest(req.method, req.url, res.status, performance.now() - started, res.headers.get('content-length'));
    return res;
  };
}

export function wrapRoutes<T extends Record<string, RouteValue>>(routes: T): T {
  const wrapped: Record<string, RouteValue> = {};
  for (const [pattern, value] of Object.entries(routes)) {
    if (typeof value === 'function') {
      wrapped[pattern] = decorate(value);
      continue;
    }
    const methods: Record<string, Handler> = {};
    for (const [method, handler] of Object.entries(value)) methods[method] = decorate(handler);
    // A route object only answers the methods it lists, so preflight needs an
    // explicit entry or OPTIONS would 404.
    methods.OPTIONS ??= decorate(() => new Response(null, { status: 204 }));
    wrapped[pattern] = methods;
  }
  // The decorator preserves each entry's shape, which the signature asserts so
  // that callers keep Bun's per-path request typing.
  return wrapped as T;
}

/**
 * Parse a JSON body, tolerating an absent or unparseable one.
 *
 * `express.json()` left `req.body` undefined in both cases and every route then
 * used `req.body?.x`, so the endpoints' own validation produced the 400 — not
 * the parser.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
