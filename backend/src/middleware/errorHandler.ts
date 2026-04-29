import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err.stack || err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  res.status(status).json({ error: (err as Error).message || 'Internal server error' });
};
