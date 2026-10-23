import { FastifyRequest } from 'fastify';
import { ServerConfig } from '../config';
import { ForbiddenError } from '../errors';

export const CSRF_HEADER_NAME = 'x-shopbook-client';
export const CSRF_HEADER_VALUE = 'web-v1';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Protects cookie-authenticated state-changing endpoints against Cross-Site Request Forgery (CSRF):
 * 1. Requires `X-ShopBook-Client: web-v1` custom request header (blocks plain HTML form / img / navigation CSRF).
 * 2. When the browser includes an `Origin` header, verifies it matches either the current `Host` or
 *    an explicitly configured `CORS_ALLOWED_ORIGINS` origin.
 */
export function verifyCsrfProtection(
  request: FastifyRequest,
  config: ServerConfig
): void {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    return;
  }

  if (!request.url.startsWith('/api/')) {
    return;
  }

  const clientHeader = request.headers[CSRF_HEADER_NAME];
  if (clientHeader !== CSRF_HEADER_VALUE) {
    throw new ForbiddenError(
      'Missing or invalid ShopBook client security header.',
      'CSRF_HEADER_INVALID'
    );
  }

  const originHeader = request.headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim()) {
    let originUrl: URL;
    try {
      originUrl = new URL(originHeader);
    } catch {
      throw new ForbiddenError('Invalid request Origin header.', 'CSRF_ORIGIN_INVALID');
    }

    const forwardedHost = request.headers['x-forwarded-host'];
    const rawHost =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
      request.headers.host ??
      '';
    const expectedHost = rawHost.split(',')[0].trim().toLowerCase();

    const matchesHost =
      Boolean(expectedHost) && originUrl.host.toLowerCase() === expectedHost;
    const matchesAllowlist = config.corsAllowedOrigins.some(
      (allowed) => allowed.toLowerCase() === originUrl.origin.toLowerCase()
    );

    if (!matchesHost && !matchesAllowlist) {
      throw new ForbiddenError(
        'Cross-origin state-changing request blocked.',
        'CSRF_ORIGIN_MISMATCH'
      );
    }
  }
}
