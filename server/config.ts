import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /**
   * Standard PostgreSQL connection string (`postgresql://...`) for Render / production / Docker.
   * When omitted in local development or tests, ShopBook automatically uses embedded PostgreSQL
   * (`pglite://.local-pgdata` in dev or `pglite://memory` in tests) with the exact same SQL migrations.
   */
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z
    .enum(['true', 'false', 'require', 'disable'])
    .optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default('sb_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  TRUST_PROXY: z.enum(['true', 'false']).default('true'),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  /** Free-pilot controls: pilot shops get unrestricted access without payment prompts */
  DEFAULT_PILOT_EXEMPT: z.enum(['true', 'false']).default('true'),
  ENFORCE_SUBSCRIPTIONS: z.enum(['true', 'false']).default('false'),
  SERVE_STATIC_DIST: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  sessionCookieName: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  corsAllowedOrigins: string[];
  defaultPilotExempt: boolean;
  enforceSubscriptions: boolean;
  serveStaticDist: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function loadServerConfig(
  rawEnv: Record<string, string | undefined> = process.env
): ServerConfig {
  const parsed = EnvSchema.parse(rawEnv);

  const defaultDbUrl =
    parsed.NODE_ENV === 'test'
      ? 'pglite://memory'
      : parsed.NODE_ENV === 'development'
        ? 'pglite://.local-pgdata'
        : '';

  const databaseUrl = (parsed.DATABASE_URL ?? '').trim() || defaultDbUrl;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required when NODE_ENV=production.'
    );
  }

  const databaseSsl =
    parsed.DATABASE_SSL === 'true' ||
    parsed.DATABASE_SSL === 'require' ||
    (parsed.DATABASE_SSL === undefined &&
      parsed.NODE_ENV === 'production' &&
      (databaseUrl.startsWith('postgres://') ||
        databaseUrl.startsWith('postgresql://')) &&
      !databaseUrl.includes('sslmode=disable'));

  const cookieSecure =
    parsed.COOKIE_SECURE === 'true'
      ? true
      : parsed.COOKIE_SECURE === 'false'
        ? false
        : parsed.NODE_ENV === 'production';

  const corsAllowedOrigins = parsed.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl,
    databaseSsl,
    sessionCookieName: parsed.SESSION_COOKIE_NAME,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    cookieSecure,
    trustProxy: parsed.TRUST_PROXY === 'true',
    corsAllowedOrigins,
    defaultPilotExempt: parsed.DEFAULT_PILOT_EXEMPT === 'true',
    enforceSubscriptions: parsed.ENFORCE_SUBSCRIPTIONS === 'true',
    serveStaticDist: parsed.SERVE_STATIC_DIST === 'true',
    logLevel: parsed.NODE_ENV === 'test' ? 'silent' : parsed.LOG_LEVEL,
  };
}
