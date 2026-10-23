import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServerApp } from '../../server/app';
import { hashPassword } from '../../server/auth/crypto';
import { loadServerConfig, ServerConfig } from '../../server/config';
import { createDatabaseContext, DatabaseContext } from '../../server/db/client';
import { runMigrations } from '../../server/db/migrate';
import {
  auditLogs,
  authSessions,
  shopMembers,
  users,
} from '../../server/db/schema';
import { buildRequireAuth } from '../../server/middleware/auth';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../../server/middleware/csrf';
import { issueAdminPasswordResetCode } from '../../server/services/authService';
import { evaluateEntitlementPolicy } from '../../server/services/entitlementService';
import {
  normalizeEmail,
  normalizeZambianPhone,
  parseAuthIdentifier,
} from '../shared/identifiers';

const CSRF_HEADERS = {
  [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
};

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  expect(first).toBeTruthy();
  return first!.split(';')[0];
}

describe('Milestone 2 Stage 1 — PostgreSQL Schema, Migrations, Auth, Recovery, Isolation & Pilot Entitlements', () => {
  let dbCtx: DatabaseContext;
  let config: ServerConfig;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadServerConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      COOKIE_SECURE: 'true',
      DEFAULT_PILOT_EXEMPT: 'true',
      ENFORCE_SUBSCRIPTIONS: 'false',
    });
    dbCtx = await createDatabaseContext({ databaseUrl: config.databaseUrl });
    await runMigrations(dbCtx);
  });

  afterAll(async () => {
    await dbCtx.close();
  });

  beforeEach(async () => {
    await dbCtx.execRawSql(`
      TRUNCATE
        audit_logs,
        sync_ledger,
        applied_operations,
        stock_conflicts,
        credit_transactions,
        stock_movements,
        sale_items,
        sales,
        customers,
        products,
        shop_entitlements,
        password_reset_tokens,
        auth_sessions,
        shop_members,
        shops,
        users
      RESTART IDENTITY CASCADE;
    `);

    app = await buildServerApp({
      dbCtx,
      config,
      registerExtraRoutes: async (instance, ctx, cfg) => {
        const ownerOnly = buildRequireAuth(ctx, cfg, ['owner']);
        instance.post(
          '/api/v1/test/owner-only',
          { preHandler: ownerOnly },
          async (req) => ({ ok: true, shopId: req.auth!.shop.id })
        );
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('normalizes Zambian Airtel/MTN/Zamtel phone formats and emails accurately', () => {
    expect(normalizeZambianPhone('097 712-3456')).toBe('+260977123456');
    expect(normalizeZambianPhone('260966554433')).toBe('+260966554433');
    expect(normalizeZambianPhone('+260 955 112 233')).toBe('+260955112233');
    expect(normalizeZambianPhone('0771234567')).toBe('+260771234567');

    expect(() => normalizeZambianPhone('0123456789')).toThrow();
    expect(() => normalizeZambianPhone('+14155552671')).toThrow();

    expect(normalizeEmail('  Chipo.Banda@Example.COM ')).toBe(
      'chipo.banda@example.com'
    );
    expect(parseAuthIdentifier('0977123456')).toEqual({
      kind: 'phone',
      phoneE164: '+260977123456',
      normalized: '+260977123456',
    });
  });

  it('applies PostgreSQL migrations idempotently without losing records', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Mutale Phiri',
        shopName: 'Phiri Corner Store',
        phone: '0977111222',
        password: 'StrongPassword123!',
      },
    });

    // Re-running migrations on an already-migrated database must skip applied files and preserve data
    const secondRun = await runMigrations(dbCtx);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toContain('0001_milestone2_foundation.sql');

    const storedUsers = await dbCtx.db.select().from(users);
    expect(storedUsers).toHaveLength(1);
    expect(storedUsers[0].phoneE164).toBe('+260977111222');
  });

  it('registers pilot owner, hashes passwords/tokens, sets HttpOnly Secure cookie, and grants full pilot entitlement', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Mwansa Mulenga',
        shopName: 'Mulenga General Dealers',
        phone: '097 788-9900',
        email: 'MWANSA@EXAMPLE.COM',
        password: 'MySecretShopPassword99',
      },
    });

    expect(regRes.statusCode).toBe(201);
    const setCookie = regRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Lax');
    expect(cookieStr).toContain('Secure');

    const body = regRes.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.phoneE164).toBe('+260977889900');
    expect(body.user.email).toBe('mwansa@example.com');
    expect(body.issuedRecoveryKey).toMatch(/^SBRK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.shop.role).toBe('owner');
    expect(body.shop.entitlement).toMatchObject({
      planCode: 'pilot_free',
      status: 'pilot_free',
      isPilotExempt: true,
      allowNewSales: true,
      allowRepayments: true,
      allowExports: true,
      showPaymentPrompt: false,
    });

    // Verify plaintext password and raw session token are NEVER stored in PostgreSQL
    const [dbUser] = await dbCtx.db.select().from(users);
    expect(dbUser.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(dbUser.passwordHash).not.toContain('MySecretShopPassword99');
    expect(dbUser.recoveryCodeHash).not.toContain(body.issuedRecoveryKey);

    const rawCookieVal = extractSessionCookie(setCookie).split('=')[1];
    const [dbSession] = await dbCtx.db.select().from(authSessions);
    expect(dbSession.tokenHash).not.toBe(rawCookieVal);
    expect(dbSession.tokenHash).toHaveLength(64);

    // Duplicate registration with same phone or email returns 409 Conflict
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Another Name',
        shopName: 'Another Shop',
        phone: '+260977889900',
        password: 'AnotherPassword123',
      },
    });
    expect(dupRes.statusCode).toBe(409);
  });

  it('supports login by phone or email, revokes session on logout, and enforces CSRF & rate limits', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Bwalya Tembo',
        shopName: 'Tembo Fresh Mart',
        phone: '0966123456',
        email: 'bwalya@tembo.zm',
        password: 'CorrectHorseBattery9',
      },
    });

    // Missing CSRF header must be blocked (403)
    const noCsrfRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        identifier: '0966123456',
        password: 'CorrectHorseBattery9',
      },
    });
    expect(noCsrfRes.statusCode).toBe(403);

    // Cross-origin CSRF attempt with evil Origin must be blocked (403)
    const evilOriginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        ...CSRF_HEADERS,
        host: 'shopbook.example.com',
        origin: 'https://evil-attacker.example',
      },
      payload: {
        identifier: '0966123456',
        password: 'CorrectHorseBattery9',
      },
    });
    expect(evilOriginRes.statusCode).toBe(403);

    // Login using international E.164 phone format
    const phoneLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '+260 966 123 456',
        password: 'CorrectHorseBattery9',
      },
    });
    expect(phoneLogin.statusCode).toBe(200);
    const cookie = extractSessionCookie(phoneLogin.headers['set-cookie']);

    // Verify /api/v1/auth/me works with cookie and sets Cache-Control: no-store
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.headers['cache-control']).toContain('no-store');
    expect(meRes.json().authenticated).toBe(true);

    // Logout revokes session server-side so replaying the old cookie no longer authenticates
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...CSRF_HEADERS, cookie },
    });
    expect(logoutRes.statusCode).toBe(200);

    const replayMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(replayMe.json().authenticated).toBe(false);

    // Brute-force login rate limiter triggers 429 Too Many Requests after 10 attempts
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const badLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: CSRF_HEADERS,
        payload: {
          identifier: 'bwalya@tembo.zm',
          password: 'WrongPasswordAttempt',
        },
      });
      lastStatus = badLogin.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it('recovers account safely via Emergency Recovery Key or Admin Reset Code and revokes active sessions', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Lungu Shopkeeper',
        shopName: 'Ndola Market Kiosk',
        phone: '0955987654',
        password: 'OldPassword123!',
      },
    });
    const oldCookie = extractSessionCookie(reg.headers['set-cookie']);
    const initialRecoveryKey: string = reg.json().issuedRecoveryKey;

    // 1. Reset password using Emergency Recovery Key
    const reset1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '0955987654',
        recoveryCode: initialRecoveryKey,
        newPassword: 'NewPassword456!',
      },
    });
    expect(reset1.statusCode).toBe(200);
    expect(reset1.json().issuedRecoveryKey).not.toBe(initialRecoveryKey);

    // Old session cookie must now be revoked!
    const oldSessionCheck = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: oldCookie },
    });
    expect(oldSessionCheck.json().authenticated).toBe(false);

    // Reusing the consumed recovery key must fail (401)
    const replayReset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '0955987654',
        recoveryCode: initialRecoveryKey,
        newPassword: 'AnotherPassword789!',
      },
    });
    expect(replayReset.statusCode).toBe(401);

    // 2. Admin-issued 30-minute single-use Reset Code (for pilot support without paid SMS)
    const adminIssued = await issueAdminPasswordResetCode(dbCtx, '0955987654', 30);
    expect(adminIssued.rawResetCode).toMatch(/^SBRST-/);

    const reset2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '+260955987654',
        recoveryCode: adminIssued.rawResetCode,
        newPassword: 'FinalPassword999!',
      },
    });
    expect(reset2.statusCode).toBe(200);

    // Reusing the single-use admin reset code must fail
    const replayAdminCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '+260955987654',
        recoveryCode: adminIssued.rawResetCode,
        newPassword: 'HackedPassword000!',
      },
    });
    expect(replayAdminCode.statusCode).toBe(401);

    // Login succeeds with FinalPassword999!
    const finalLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '0955987654',
        password: 'FinalPassword999!',
      },
    });
    expect(finalLogin.statusCode).toBe(200);
  });

  it('prevents cross-shop access (403 + security audit log) and enforces owner vs cashier role permissions', async () => {
    const regShopA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Owner A',
        shopName: 'Shop Alpha',
        phone: '0977000001',
        password: 'ShopAPassword123',
      },
    });
    const cookieA = extractSessionCookie(regShopA.headers['set-cookie']);
    const shopAId: string = regShopA.json().shop.id;

    const regShopB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF_HEADERS,
      payload: {
        fullName: 'Owner B',
        shopName: 'Shop Bravo',
        phone: '0977000002',
        password: 'ShopBPassword123',
      },
    });
    const shopBId: string = regShopB.json().shop.id;

    // Owner A attempts to target Shop B via X-Shop-Id header -> MUST be rejected with 403 Forbidden
    const crossShopAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: cookieA,
        'x-shop-id': shopBId,
      },
    });
    expect(crossShopAttempt.statusCode).toBe(403);

    const crossAudit = await dbCtx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.eventType, 'security.cross_shop_denied'));
    expect(crossAudit).toHaveLength(1);

    // Insert a cashier member into Shop A to verify owner vs cashier role model works
    const cashierId = crypto.randomUUID();
    await dbCtx.db.insert(users).values({
      id: cashierId,
      fullName: 'Cashier Zulu',
      phoneE164: '+260977000003',
      email: null,
      passwordHash: await hashPassword('CashierPass123'),
      isActive: true,
    });
    await dbCtx.db.insert(shopMembers).values({
      id: crypto.randomUUID(),
      shopId: shopAId,
      userId: cashierId,
      role: 'cashier',
      isActive: true,
    });

    const cashierLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF_HEADERS,
      payload: {
        identifier: '0977000003',
        password: 'CashierPass123',
      },
    });
    expect(cashierLogin.statusCode).toBe(200);
    expect(cashierLogin.json().shop.role).toBe('cashier');
    const cashierCookie = extractSessionCookie(cashierLogin.headers['set-cookie']);

    // Cashier calling an owner-only endpoint gets 403, while Owner A gets 200
    const cashierOwnerEndpoint = await app.inject({
      method: 'POST',
      url: '/api/v1/test/owner-only',
      headers: { ...CSRF_HEADERS, cookie: cashierCookie },
    });
    expect(cashierOwnerEndpoint.statusCode).toBe(403);

    const ownerEndpoint = await app.inject({
      method: 'POST',
      url: '/api/v1/test/owner-only',
      headers: { ...CSRF_HEADERS, cookie: cookieA },
    });
    expect(ownerEndpoint.statusCode).toBe(200);
  });

  it('evaluates future trial & expired read-only entitlement rules without ever blocking repayments or exports', () => {
    const expiredDate = new Date('2026-10-01T00:00:00Z');
    const now = new Date('2026-10-23T12:00:00Z');

    // During Milestone 2 (enforceSubscriptions = false), even an expired record remains unrestricted
    const pilotMode = evaluateEntitlementPolicy(
      {
        planCode: 'future_trial',
        planName: 'Trial',
        status: 'trialing',
        isPilotExempt: false,
        trialStartedAt: new Date('2026-09-01T00:00:00Z'),
        trialEndsAt: expiredDate,
        currentPeriodEndsAt: null,
      },
      { enforceSubscriptions: false, now }
    );
    expect(pilotMode.allowNewSales).toBe(true);
    expect(pilotMode.showPaymentPrompt).toBe(false);

    // When subscription enforcement is turned on in the future for a non-exempt expired trial:
    // new sales are restricted, while repayments and exports remain open!
    const enforcedExpired = evaluateEntitlementPolicy(
      {
        planCode: 'future_trial',
        planName: 'Trial',
        status: 'trialing',
        isPilotExempt: false,
        trialStartedAt: new Date('2026-09-01T00:00:00Z'),
        trialEndsAt: expiredDate,
        currentPeriodEndsAt: null,
      },
      { enforceSubscriptions: true, now }
    );
    expect(enforcedExpired.status).toBe('expired_read_only');
    expect(enforcedExpired.allowNewSales).toBe(false);
    expect(enforcedExpired.allowRepayments).toBe(true);
    expect(enforcedExpired.allowExports).toBe(true);

    // Pilot-exempt shops ALWAYS keep unrestricted access even after future enforcement is turned on!
    const pilotExemptWhenEnforced = evaluateEntitlementPolicy(
      {
        planCode: 'pilot_free',
        planName: 'Free Pilot Access',
        status: 'pilot_free',
        isPilotExempt: true,
        trialStartedAt: null,
        trialEndsAt: null,
        currentPeriodEndsAt: null,
      },
      { enforceSubscriptions: true, now }
    );
    expect(pilotExemptWhenEnforced.allowNewSales).toBe(true);
    expect(pilotExemptWhenEnforced.showPaymentPrompt).toBe(false);
  });
});
