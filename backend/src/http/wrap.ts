/**
 * Cross-cutting behaviour, as a decorator over the route table.
 *
 * Routes are plain values, so anything that must apply to all of them is
 * applied once, here. Doing it centrally is what stops a new route from quietly
 * shipping without error handling or logging.
 *
 * Order: the handler runs, any error it throws becomes the JSON error shape,
 * and the request is logged last so the line carries the final status.
 */
import { logRequest } from './log.ts';
import { fail } from './respond.ts';

type Handler = (req: any, server: any) => Response | Promise<Response>;
type RouteValue = Handler | Record<string, Handler>;

/** A thrown `statusCode` is honoured; anything else is a 500. */
function errorResponse(err: unknown): Response {
  console.error((err as Error)?.stack || err);
  const status = (err as { statusCode?: number })?.statusCode ?? 500;
  return fail((err as Error)?.message || 'Internal server error', status);
}

function decorate(handler: Handler): Handler {
  return async (req, server) => {
    const started = performance.now();
    let res: Response;
    try {
      res = await handler(req, server);
    } catch (err) {
      res = errorResponse(err);
    }
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
    wrapped[pattern] = methods;
  }
  // The decorator preserves each entry's shape, which the signature asserts so
  // that callers keep Bun's per-path request typing.
  return wrapped as T;
}

/**
 * Parse a JSON body, tolerating an absent or unparseable one.
 *
 * Both cases yield `undefined` rather than throwing, which leaves the 400 to
 * each endpoint's own validation — `trackId is required` is a better answer
 * than a parser error, and every route already checks its fields.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
