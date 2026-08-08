import { Request, Response, NextFunction } from 'express';
import Logger from '../lib/logger';

const SENSITIVE_KEYS = ['password', 'token', 'code', 'secret', 'authorization', 'session_key'];

function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_KEYS.some((sk) => key.toLowerCase().includes(sk))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  Logger.error('Unhandled error caught by global error handler:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req?.user?.id,
    query: req.query,
    body: sanitizeBody(req.body),
    headers: {
      userAgent: req.headers['user-agent'],
      contentType: req.headers['content-type'],
    },
  });

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message,
    });
  }

  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }

  if (err.name === 'ForbiddenError' || err.status === 403) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource',
    });
  }

  if (err.name === 'NotFoundError' || err.status === 404) {
    return res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource was not found',
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message || 'An unexpected error occurred';

  return res.status(statusCode).json({
    error: 'Internal Server Error',
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/**
 * Middleware to catch 404 errors for unmatched routes
 */
export const notFoundHandler = (req: Request, res: Response) => {
  Logger.warn(`404 Not Found: ${req.method} ${req.path} (ip: ${req.ip})`);

  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
};
