import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthSessionResponse } from '../../src/shared/syncTypes';
import { ServerConfig } from '../config';
import { DatabaseContext } from '../db/client';
import { BadRequestError } from '../errors';
import {
  buildRequireAuth,
  clearSessionCookie,
  setSessionCookie,
} from '../middleware/auth';
import { SlidingWindowRateLimiter } from '../middleware/rateLimit';
import {
  authenticateSession,
  confirmPasswordReset,
  loginWithPassword,
  logoutSession,
  registerOwnerAndShop,
  requestPasswordReset,
  rotateEmergencyRecoveryKey,
} from '../services/authService';

const RegisterBodySchema = z.object({
  fullName: z.string().min(1, 'Full name is required.').max(100),
  shopName: z.string().min(1, 'Shop name is required.').max(80),
  phone: z.string().max(40).optional().nullable(),
  email: z.string().max(254).optional().nullable(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long.')
    .max(128),
});

const LoginBodySchema = z.object({
  identifier: z
    .string()
    .min(1, 'Enter your Zambian phone number or email address.')
    .max(254),
  password: z.string().min(1, 'Password is required.').max(128),
});

const PasswordResetRequestSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Enter your Zambian phone number or email address.')
    .max(254),
});

const PasswordResetConfirmSchema = z.object({
  identifier: z
    .string()
    .min(1, 'Enter your Zambian phone number or email address.')
    .max(254),
  recoveryCode: z
    .string()
    .min(8, 'Enter your Emergency Recovery Key or Reset Code.')
    .max(64),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters long.')
    .max(128),
});

const RotateRecoveryBodySchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.').max(128),
});

function parseZodOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new BadRequestError(firstIssue?.message ?? 'Invalid request input.');
  }
  return result.data;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  dbCtx: DatabaseContext,
  config: ServerConfig
): Promise<void> {
  const authRateLimiter = new SlidingWindowRateLimiter({
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
  });

  const recoveryRateLimiter = new SlidingWindowRateLimiter({
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
  });

  const requireAuth = buildRequireAuth(dbCtx, config, ['owner', 'cashier']);

  app.post('/api/v1/auth/register', async (request, reply) => {
    authRateLimiter.consume(`register:${request.ip}`);
    const body = parseZodOrThrow(RegisterBodySchema, request.body);

    const { rawSessionToken, expiresAt, response } = await registerOwnerAndShop(
      dbCtx,
      config,
      {
        fullName: body.fullName,
        shopName: body.shopName,
        phone: body.phone ?? null,
        email: body.email ?? null,
        password: body.password,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }
    );

    setSessionCookie(reply, config, rawSessionToken, expiresAt);
    return reply.status(201).send(response);
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parseZodOrThrow(LoginBodySchema, request.body);
    authRateLimiter.consume(
      `login:${request.ip}:${body.identifier.trim().toLowerCase()}`
    );

    const { rawSessionToken, expiresAt, response } = await loginWithPassword(
      dbCtx,
      config,
      {
        identifier: body.identifier,
        password: body.password,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }
    );

    setSessionCookie(reply, config, rawSessionToken, expiresAt);
    return reply.status(200).send(response);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const rawToken = request.cookies[config.sessionCookieName];
    await logoutSession(dbCtx, rawToken, request.ip);
    clearSessionCookie(reply, config);
    return reply.status(200).send({ loggedOut: true });
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const rawToken = request.cookies[config.sessionCookieName];
    if (!rawToken) {
      const anonymous: AuthSessionResponse = {
        authenticated: false,
        user: null,
        shop: null,
        memberships: [],
      };
      return reply.status(200).send(anonymous);
    }

    try {
      const requestedShopHeader = request.headers['x-shop-id'];
      const requestedShopId = Array.isArray(requestedShopHeader)
        ? requestedShopHeader[0]
        : requestedShopHeader;

      const auth = await authenticateSession(dbCtx, config, {
        rawSessionToken: rawToken,
        requestedShopId: requestedShopId ?? null,
        ipAddress: request.ip,
      });

      if (auth.refreshedCookieExpiresAt) {
        setSessionCookie(
          reply,
          config,
          rawToken,
          auth.refreshedCookieExpiresAt
        );
      }

      const response: AuthSessionResponse = {
        authenticated: true,
        user: auth.user,
        shop: auth.shop,
        memberships: auth.memberships,
      };
      return reply.status(200).send(response);
    } catch (err) {
      // Preserve explicit 403 cross-shop isolation errors; clear stale 401 cookies gracefully
      if (
        err &&
        typeof err === 'object' &&
        'statusCode' in err &&
        err.statusCode === 403
      ) {
        throw err;
      }
      clearSessionCookie(reply, config);
      const anonymous: AuthSessionResponse = {
        authenticated: false,
        user: null,
        shop: null,
        memberships: [],
      };
      return reply.status(200).send(anonymous);
    }
  });

  app.post('/api/v1/auth/password-reset/request', async (request, reply) => {
    const body = parseZodOrThrow(PasswordResetRequestSchema, request.body);
    recoveryRateLimiter.consume(
      `reset-req:${request.ip}:${body.identifier.trim().toLowerCase()}`
    );

    await requestPasswordReset(dbCtx, body.identifier, request.ip);
    return reply.status(200).send({
      accepted: true,
      message:
        'If an account matches that phone or email, reset eligibility has been recorded. Enter your Emergency Recovery Key (SBRK-...) or Pilot Reset Code (SBRST-...) to set a new password.',
    });
  });

  app.post('/api/v1/auth/password-reset/confirm', async (request, reply) => {
    const body = parseZodOrThrow(PasswordResetConfirmSchema, request.body);
    recoveryRateLimiter.consume(
      `reset-confirm:${request.ip}:${body.identifier.trim().toLowerCase()}`
    );

    const result = await confirmPasswordReset(dbCtx, {
      identifier: body.identifier,
      recoveryCode: body.recoveryCode,
      newPassword: body.newPassword,
      ipAddress: request.ip,
    });

    clearSessionCookie(reply, config);
    return reply.status(200).send(result);
  });

  app.post(
    '/api/v1/auth/recovery-code/rotate',
    { preHandler: requireAuth },
    async (request, reply) => {
      recoveryRateLimiter.consume(`rotate:${request.auth!.user.id}`);
      const body = parseZodOrThrow(RotateRecoveryBodySchema, request.body);
      const result = await rotateEmergencyRecoveryKey(dbCtx, {
        userId: request.auth!.user.id,
        shopId: request.auth!.shop.id,
        currentPassword: body.currentPassword,
        ipAddress: request.ip,
      });
      return reply.status(200).send(result);
    }
  );
}
