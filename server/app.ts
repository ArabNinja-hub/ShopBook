import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { FastifyInstance } from 'fastify';
import { ServerConfig } from './config';
import { DatabaseContext } from './db/client';
import { ApiError, RateLimitError } from './errors';
import { verifyCsrfProtection } from './middleware/csrf';
import { registerAuthRoutes } from './routes/authRoutes';
import { registerHealthRoutes } from './routes/healthRoutes';
import { registerSyncRoutes } from './routes/syncRoutes';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface BuildServerOptions {
  dbCtx: DatabaseContext;
  config: ServerConfig;
  registerExtraRoutes?: (
    app: FastifyInstance,
    dbCtx: DatabaseContext,
    config: ServerConfig
  ) => Promise<void>;
}

export async function buildServerApp(
  options: BuildServerOptions
): Promise<FastifyInstance> {
  const { dbCtx, config } = options;

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024, // 2 MB max JSON payload
  });

  await app.register(fastifyCookie);

  // Security & CORS headers + PWA-safe Cache-Control on /api/*
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    }

    const origin = request.headers.origin;
    if (
      origin &&
      config.corsAllowedOrigins.some(
        (allowed) => allowed.toLowerCase() === origin.toLowerCase()
      )
    ) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, X-ShopBook-Client, X-Shop-Id'
      );
      reply.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS'
      );

      if (request.method === 'OPTIONS') {
        return reply.status(204).send();
      }
    }

    verifyCsrfProtection(request, config);
  });

  // Centralized safe error handler (never exposes raw database errors or stack traces)
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof RateLimitError) {
      reply.header('Retry-After', String(err.retryAfterSeconds));
      return reply.status(429).send({
        error: {
          code: err.code,
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        },
      });
    }

    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
        },
      });
    }

    if (
      err &&
      typeof err === 'object' &&
      'statusCode' in err &&
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      const msg =
        'message' in err && typeof err.message === 'string'
          ? err.message
          : 'Invalid request.';
      return reply.status(err.statusCode).send({
        error: {
          code: 'BAD_REQUEST',
          message: msg,
        },
      });
    }

    request.log.error({ err }, 'Unhandled server error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected server error occurred. Your local shop records remain safe.',
      },
    });
  });

  await registerHealthRoutes(app, dbCtx);
  await registerAuthRoutes(app, dbCtx, config);
  await registerSyncRoutes(app, dbCtx, config);

  if (options.registerExtraRoutes) {
    await options.registerExtraRoutes(app, dbCtx, config);
  }

  // Optional portable single-service SPA static asset serving (`SERVE_STATIC_DIST=true`)
  if (config.serveStaticDist) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'API endpoint not found.' },
        });
      }

      const rawPathname = request.url.split('?')[0] || '/';
      const safeRelPath = path
        .normalize(decodeURIComponent(rawPathname))
        .replace(/^(\.\.(\/|\\|$))+/, '')
        .replace(/^[/\\]+/, '');

      const candidate = path.resolve(distDir, safeRelPath || 'index.html');
      const resolvedFile =
        candidate.startsWith(distDir) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
          ? candidate
          : path.join(distDir, 'index.html');

      if (!fs.existsSync(resolvedFile)) {
        return reply.status(404).send('Build output not found. Run npm run build first.');
      }

      const ext = path.extname(resolvedFile).toLowerCase();
      reply.header(
        'Content-Type',
        MIME_BY_EXT[ext] ?? 'application/octet-stream'
      );
      if (resolvedFile.endsWith('index.html')) {
        reply.header('Cache-Control', 'no-cache');
      } else if (safeRelPath.startsWith('assets/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return reply.send(fs.readFileSync(resolvedFile));
    });
  }

  return app;
}
