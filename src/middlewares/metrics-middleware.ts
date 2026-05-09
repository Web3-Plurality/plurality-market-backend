import { Request, Response, NextFunction } from 'express';
import {
  httpRequestDuration,
  httpRequestTotal,
  httpRequestSize,
  httpResponseSize,
  httpActiveRequests,
} from '../lib/metrics';

/**
 * Extract route pattern from Express request
 */
function getRoutePattern(req: Request): string {
  if (req.route?.path) {
    return req.baseUrl + req.route.path;
  }
  // Fallback to path for non-matched routes
  return req.path || 'unknown';
}

/**
 * Extract service name from route
 */
function getServiceFromRoute(route: string): string {
  const parts = route.split('/').filter(Boolean);
  if (parts.length === 0) return 'root';

  // Map routes to service names
  if (route.startsWith('/auth')) return 'auth';
  if (route.startsWith('/user')) return 'user';
  if (route.startsWith('/oauth')) return 'oauth';
  if (route.startsWith('/crm')) return 'crm';
  if (route.startsWith('/ai')) return 'ai';
  if (route.startsWith('/docs')) return 'docs';
  if (route === '/metrics') return 'metrics';

  return parts[0] || 'unknown';
}

/**
 * Middleware to collect HTTP metrics for Prometheus
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip metrics collection for the /metrics endpoint itself
  if (req.path === '/metrics') {
    return next();
  }

  const start = Date.now();
  const route = getRoutePattern(req);
  const service = getServiceFromRoute(route);
  const method = req.method;

  // Track active requests
  httpActiveRequests.inc({ method, service });

  // Track request size
  const requestSize = parseInt(req.get('content-length') || '0', 10);
  if (requestSize > 0) {
    httpRequestSize.observe({ method, route, service }, requestSize);
  }

  // Override res.end to capture response metrics
  const originalEnd = res.end;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = function (this: Response, chunk?: any, encoding?: any, callback?: any): Response {
    // Calculate duration
    const duration = (Date.now() - start) / 1000;
    const statusCode = res.statusCode.toString();

    // Record metrics

    httpRequestDuration.observe({ method, route, status_code: statusCode, service }, duration);

    httpRequestTotal.inc({ method, route, status_code: statusCode, service });

    // Track response size
    const responseSize = parseInt(res.get('content-length') || '0', 10);
    if (responseSize > 0) {
      httpResponseSize.observe({ method, route, service }, responseSize);
    }

    // Decrement active requests
    httpActiveRequests.dec({ method, service });

    // Call original end function
    return originalEnd.call(this, chunk, encoding, callback);
  };

  next();
}
