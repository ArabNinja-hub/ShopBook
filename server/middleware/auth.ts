import { FastifyReply, FastifyRequest } from 'fastify';
import { ShopMemberRole } from '../../src/shared/syncTypes';
import { ServerConfig } from '../config';
import { DatabaseContext } from '../db/client';
import { ForbiddenError } from '../errors';
import {
  AuthenticatedContext,
  authenticateSession,
} from '../services/authService';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedContext;
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  config: ServerConfig,
  rawToken: string,
  expiresAt: Date
): void {
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  reply.setCookie(config.sessionCookieName, rawToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: expiresAt,
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  config: ServerConfig
): void {
  reply.clearCookie(config.sessionCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
  });
}

export function buildRequireAuth(
  dbCtx: DatabaseContext,
  config: ServerConfig,
  allowedRoles: ShopMemberRole[] = ['owner', 'cashier']
) {
  return async function requireAuthHook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const rawToken = request.cookies[config.sessionCookieName];
    const requestedShopHeader = request.headers['x-shop-id'];
    const requestedShopId = Array.isArray(requestedShopHeader)
      ? requestedShopHeader[0]
      : requestedShopHeader;

    const auth = await authenticateSession(dbCtx, config, {
      rawSessionToken: rawToken,
      requestedShopId: requestedShopId ?? null,
      ipAddress: request.ip,
    });

    if (!allowedRoles.includes(auth.role)) {
      throw new ForbiddenError(
        `This action requires ${allowedRoles.join(' or ')} shop permissions.`
      );
    }

    if (auth.refreshedCookieExpiresAt && rawToken) {
      setSessionCookie(reply, config, rawToken, auth.refreshedCookieExpiresAt);
    }

    request.auth = auth;
  };
}
