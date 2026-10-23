import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ValidationError } from '../../src/domain/errors';
import {
  normalizeEmail,
  normalizeZambianPhone,
  parseAuthIdentifier,
} from '../../src/shared/identifiers';
import {
  AuthSessionResponse,
  AuthShopView,
  AuthUserView,
  ShopMemberRole,
} from '../../src/shared/syncTypes';
import {
  generateEmergencyRecoveryKey,
  generateSessionToken,
  generateSingleUseResetCode,
  hashPassword,
  normalizeRecoveryCredential,
  sha256Hex,
  verifyDummyPassword,
  verifyPassword,
} from '../auth/crypto';
import { ServerConfig } from '../config';
import { DatabaseContext } from '../db/client';
import {
  authSessions,
  passwordResetTokens,
  shopMembers,
  shops,
  syncLedger,
  users,
} from '../db/schema';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from '../errors';
import { recordAuditEvent } from './auditService';
import {
  createInitialShopEntitlement,
  getShopEntitlementView,
} from './entitlementService';

export interface AuthenticatedContext {
  sessionId: string;
  user: AuthUserView;
  shop: AuthShopView;
  role: ShopMemberRole;
  memberships: Array<{
    shopId: string;
    shopName: string;
    role: ShopMemberRole;
  }>;
  refreshedCookieExpiresAt?: Date;
}

function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new BadRequestError('Password must be at least 8 characters long.');
  }
  if (password.length > 128) {
    throw new BadRequestError('Password must be 128 characters or fewer.');
  }
}

function buildShopSlug(shopName: string): string {
  const base = shopName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shop';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

function toSafeIdentifierError(err: unknown): never {
  if (err instanceof ValidationError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

export async function registerOwnerAndShop(
  dbCtx: DatabaseContext,
  config: ServerConfig,
  input: {
    fullName: string;
    shopName: string;
    phone?: string | null;
    email?: string | null;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{
  rawSessionToken: string;
  expiresAt: Date;
  response: AuthSessionResponse;
}> {
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (!fullName || fullName.length > 100) {
    throw new BadRequestError('Full name is required (1 to 100 characters).');
  }

  const shopName = input.shopName.trim().replace(/\s+/g, ' ');
  if (!shopName || shopName.length > 80) {
    throw new BadRequestError('Shop name is required (1 to 80 characters).');
  }

  validatePasswordStrength(input.password);

  let phoneE164: string | null = null;
  let email: string | null = null;

  try {
    if (input.phone && input.phone.trim()) {
      phoneE164 = normalizeZambianPhone(input.phone);
    }
    if (input.email && input.email.trim()) {
      email = normalizeEmail(input.email);
    }
  } catch (err) {
    toSafeIdentifierError(err);
  }

  if (!phoneE164 && !email) {
    throw new BadRequestError(
      'Enter a Zambian mobile number, an email address, or both.'
    );
  }

  const passwordHash = await hashPassword(input.password);
  const recovery = await generateEmergencyRecoveryKey();
  const sessionToken = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000
  );

  const userId = crypto.randomUUID();
  const shopId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const slug = buildShopSlug(shopName);

  const response = await dbCtx.runInTransaction(async (tx) => {
    if (phoneE164) {
      const existingPhone = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phoneE164, phoneE164))
        .limit(1);
      if (existingPhone.length > 0) {
        throw new ConflictError(
          'An account with this phone number already exists. Please sign in instead.'
        );
      }
    }

    if (email) {
      const existingEmail = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existingEmail.length > 0) {
        throw new ConflictError(
          'An account with this email address already exists. Please sign in instead.'
        );
      }
    }

    await tx.insert(users).values({
      id: userId,
      fullName,
      phoneE164,
      email,
      passwordHash,
      recoveryCodeHash: recovery.hash,
      recoveryCodeHint: recovery.hint,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(shops).values({
      id: shopId,
      name: shopName,
      slug,
      currencyCode: 'ZMW',
      timezone: 'Africa/Lusaka',
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(shopMembers).values({
      id: memberId,
      shopId,
      userId,
      role: 'owner',
      isActive: true,
      invitedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });

    await createInitialShopEntitlement(tx, shopId, config);

    await tx.insert(syncLedger).values({
      shopId,
      entityType: 'shop_settings',
      entityId: 'shopSettings',
      action: 'upsert',
      recordJson: {
        shopName,
        updatedAt: now.toISOString(),
      },
      sourceOperationId: `init_${shopId}`,
      createdAt: now,
    });

    await tx.insert(authSessions).values({
      id: sessionId,
      tokenHash: sessionToken.tokenHash,
      userId,
      activeShopId: shopId,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
      revokedAt: null,
      lastSeenAt: now,
      createdAt: now,
    });

    await recordAuditEvent(tx, {
      shopId,
      actorUserId: userId,
      eventType: 'shop.registered',
      entityType: 'shop',
      entityId: shopId,
      ipAddress: input.ipAddress ?? null,
      details: {
        shopName,
        hasPhone: Boolean(phoneE164),
        hasEmail: Boolean(email),
        role: 'owner',
      },
    });

    const entitlement = await getShopEntitlementView(tx, shopId, config);

    const authResponse: AuthSessionResponse = {
      authenticated: true,
      user: {
        id: userId,
        fullName,
        phoneE164,
        email,
        recoveryCodeHint: recovery.hint,
      },
      shop: {
        id: shopId,
        name: shopName,
        slug,
        role: 'owner',
        currencyCode: 'ZMW',
        timezone: 'Africa/Lusaka',
        entitlement,
      },
      memberships: [
        {
          shopId,
          shopName,
          role: 'owner',
        },
      ],
      issuedRecoveryKey: recovery.rawKey,
    };

    return authResponse;
  });

  return {
    rawSessionToken: sessionToken.rawToken,
    expiresAt,
    response,
  };
}

export async function loginWithPassword(
  dbCtx: DatabaseContext,
  config: ServerConfig,
  input: {
    identifier: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{
  rawSessionToken: string;
  expiresAt: Date;
  response: AuthSessionResponse;
}> {
  let parsed: ReturnType<typeof parseAuthIdentifier>;
  try {
    parsed = parseAuthIdentifier(input.identifier);
  } catch (err) {
    toSafeIdentifierError(err);
  }

  if (!input.password) {
    throw new BadRequestError('Password is required.');
  }

  const foundUsers = await dbCtx.db
    .select()
    .from(users)
    .where(
      parsed.kind === 'phone'
        ? eq(users.phoneE164, parsed.phoneE164)
        : eq(users.email, parsed.email)
    )
    .limit(1);

  const user = foundUsers[0];
  if (!user || !user.isActive) {
    await verifyDummyPassword(input.password);
    await recordAuditEvent(dbCtx.db, {
      eventType: 'auth.login_failed',
      ipAddress: input.ipAddress ?? null,
      details: { reason: 'unknown_or_inactive_identifier', kind: parsed.kind },
    });
    throw new AuthenticationError('Invalid phone/email or password.');
  }

  const validPassword = await verifyPassword(input.password, user.passwordHash);
  if (!validPassword) {
    await recordAuditEvent(dbCtx.db, {
      actorUserId: user.id,
      eventType: 'auth.login_failed',
      ipAddress: input.ipAddress ?? null,
      details: { reason: 'wrong_password' },
    });
    throw new AuthenticationError('Invalid phone/email or password.');
  }

  const memberRows = await dbCtx.db
    .select({
      shopId: shops.id,
      shopName: shops.name,
      slug: shops.slug,
      currencyCode: shops.currencyCode,
      timezone: shops.timezone,
      role: shopMembers.role,
    })
    .from(shopMembers)
    .innerJoin(shops, eq(shopMembers.shopId, shops.id))
    .where(and(eq(shopMembers.userId, user.id), eq(shopMembers.isActive, true)));

  if (memberRows.length === 0) {
    throw new ForbiddenError('No active shop membership found for this account.');
  }

  // Prefer owner membership first
  const primary =
    memberRows.find((m) => m.role === 'owner') ?? memberRows[0];

  const sessionToken = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000
  );

  await dbCtx.runInTransaction(async (tx) => {
    await tx.insert(authSessions).values({
      id: crypto.randomUUID(),
      tokenHash: sessionToken.tokenHash,
      userId: user.id,
      activeShopId: primary.shopId,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
      revokedAt: null,
      lastSeenAt: now,
      createdAt: now,
    });

    await recordAuditEvent(tx, {
      shopId: primary.shopId,
      actorUserId: user.id,
      eventType: 'auth.login_success',
      entityType: 'user',
      entityId: user.id,
      ipAddress: input.ipAddress ?? null,
    });
  });

  const entitlement = await getShopEntitlementView(
    dbCtx.db,
    primary.shopId,
    config
  );

  return {
    rawSessionToken: sessionToken.rawToken,
    expiresAt,
    response: {
      authenticated: true,
      user: {
        id: user.id,
        fullName: user.fullName,
        phoneE164: user.phoneE164,
        email: user.email,
        recoveryCodeHint: user.recoveryCodeHint,
      },
      shop: {
        id: primary.shopId,
        name: primary.shopName,
        slug: primary.slug,
        role: primary.role,
        currencyCode: primary.currencyCode,
        timezone: primary.timezone,
        entitlement,
      },
      memberships: memberRows.map((m) => ({
        shopId: m.shopId,
        shopName: m.shopName,
        role: m.role,
      })),
    },
  };
}

export async function logoutSession(
  dbCtx: DatabaseContext,
  rawSessionToken: string | undefined,
  ipAddress?: string | null
): Promise<void> {
  if (!rawSessionToken) return;
  const tokenHash = sha256Hex(rawSessionToken);
  const now = new Date();

  const existing = await dbCtx.db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      activeShopId: authSessions.activeShopId,
    })
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
    .limit(1);

  if (existing.length === 0) return;

  await dbCtx.runInTransaction(async (tx) => {
    await tx
      .update(authSessions)
      .set({ revokedAt: now })
      .where(eq(authSessions.id, existing[0].id));

    await recordAuditEvent(tx, {
      shopId: existing[0].activeShopId,
      actorUserId: existing[0].userId,
      eventType: 'auth.logout',
      entityType: 'session',
      entityId: existing[0].id,
      ipAddress: ipAddress ?? null,
    });
  });
}

export async function authenticateSession(
  dbCtx: DatabaseContext,
  config: ServerConfig,
  options: {
    rawSessionToken: string | undefined;
    requestedShopId?: string | null;
    ipAddress?: string | null;
  }
): Promise<AuthenticatedContext> {
  if (!options.rawSessionToken) {
    throw new AuthenticationError('Please sign in to continue.');
  }

  const tokenHash = sha256Hex(options.rawSessionToken);
  const now = new Date();

  const sessionRows = await dbCtx.db
    .select({
      sessionId: authSessions.id,
      userId: users.id,
      fullName: users.fullName,
      phoneE164: users.phoneE164,
      email: users.email,
      recoveryCodeHint: users.recoveryCodeHint,
      userActive: users.isActive,
      activeShopId: authSessions.activeShopId,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now)
      )
    )
    .limit(1);

  if (sessionRows.length === 0 || !sessionRows[0].userActive) {
    throw new AuthenticationError('Your session has expired. Please sign in again.');
  }

  const sess = sessionRows[0];

  const memberRows = await dbCtx.db
    .select({
      shopId: shops.id,
      shopName: shops.name,
      slug: shops.slug,
      currencyCode: shops.currencyCode,
      timezone: shops.timezone,
      role: shopMembers.role,
    })
    .from(shopMembers)
    .innerJoin(shops, eq(shopMembers.shopId, shops.id))
    .where(and(eq(shopMembers.userId, sess.userId), eq(shopMembers.isActive, true)));

  const targetShopId =
    options.requestedShopId && options.requestedShopId.trim()
      ? options.requestedShopId.trim()
      : sess.activeShopId;

  const matchingMembership = memberRows.find((m) => m.shopId === targetShopId);
  if (!matchingMembership) {
    await recordAuditEvent(dbCtx.db, {
      actorUserId: sess.userId,
      eventType: 'security.cross_shop_denied',
      entityType: 'shop',
      entityId: targetShopId,
      ipAddress: options.ipAddress ?? null,
      details: {
        requestedShopId: targetShopId,
        sessionActiveShopId: sess.activeShopId,
      },
    });
    throw new ForbiddenError(
      'Access denied: your account does not have access to this shop.'
    );
  }

  // Rolling renewal when past half of TTL
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  let refreshedCookieExpiresAt: Date | undefined;
  if (sess.expiresAt.getTime() - now.getTime() < ttlMs / 2) {
    refreshedCookieExpiresAt = new Date(now.getTime() + ttlMs);
    await dbCtx.db
      .update(authSessions)
      .set({
        expiresAt: refreshedCookieExpiresAt,
        lastSeenAt: now,
        activeShopId: matchingMembership.shopId,
      })
      .where(eq(authSessions.id, sess.sessionId));
  } else if (matchingMembership.shopId !== sess.activeShopId) {
    await dbCtx.db
      .update(authSessions)
      .set({
        lastSeenAt: now,
        activeShopId: matchingMembership.shopId,
      })
      .where(eq(authSessions.id, sess.sessionId));
  }

  const entitlement = await getShopEntitlementView(
    dbCtx.db,
    matchingMembership.shopId,
    config
  );

  return {
    sessionId: sess.sessionId,
    user: {
      id: sess.userId,
      fullName: sess.fullName,
      phoneE164: sess.phoneE164,
      email: sess.email,
      recoveryCodeHint: sess.recoveryCodeHint,
    },
    shop: {
      id: matchingMembership.shopId,
      name: matchingMembership.shopName,
      slug: matchingMembership.slug,
      role: matchingMembership.role,
      currencyCode: matchingMembership.currencyCode,
      timezone: matchingMembership.timezone,
      entitlement,
    },
    role: matchingMembership.role,
    memberships: memberRows.map((m) => ({
      shopId: m.shopId,
      shopName: m.shopName,
      role: m.role,
    })),
    refreshedCookieExpiresAt,
  };
}

/**
 * Issues a single-use, 30-minute Password Reset Code (`SBRST-XXXX-XXXX-XXXX`) for pilot support
 * (e.g., via `npm run admin:issue-reset`) without requiring paid SMS.
 */
export async function issueAdminPasswordResetCode(
  dbCtx: DatabaseContext,
  identifier: string,
  ttlMinutes = 30
): Promise<{
  userId: string;
  normalizedIdentifier: string;
  rawResetCode: string;
  expiresAt: Date;
}> {
  let parsed: ReturnType<typeof parseAuthIdentifier>;
  try {
    parsed = parseAuthIdentifier(identifier);
  } catch (err) {
    toSafeIdentifierError(err);
  }

  const found = await dbCtx.db
    .select()
    .from(users)
    .where(
      parsed.kind === 'phone'
        ? eq(users.phoneE164, parsed.phoneE164)
        : eq(users.email, parsed.email)
    )
    .limit(1);

  if (found.length === 0 || !found[0].isActive) {
    throw new BadRequestError(
      `No active ShopBook account found for "${parsed.normalized}".`
    );
  }

  const user = found[0];
  const generated = generateSingleUseResetCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await dbCtx.runInTransaction(async (tx) => {
    await tx.insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: generated.tokenHash,
      issuedChannel: 'admin_cli',
      expiresAt,
      usedAt: null,
      createdAt: now,
    });

    await recordAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'auth.password_reset_issued',
      entityType: 'user',
      entityId: user.id,
      details: { channel: 'admin_cli', ttlMinutes },
    });
  });

  return {
    userId: user.id,
    normalizedIdentifier: parsed.normalized,
    rawResetCode: generated.rawCode,
    expiresAt,
  };
}

/**
 * Public password-reset request endpoint. Always returns a uniform confirmation message
 * so account existence is never leaked. When an account has an email on file, stores a
 * hashed 30-minute token ready for email dispatch.
 */
export async function requestPasswordReset(
  dbCtx: DatabaseContext,
  identifier: string,
  ipAddress?: string | null
): Promise<{ accepted: true }> {
  let parsed: ReturnType<typeof parseAuthIdentifier>;
  try {
    parsed = parseAuthIdentifier(identifier);
  } catch (err) {
    toSafeIdentifierError(err);
  }

  const found = await dbCtx.db
    .select()
    .from(users)
    .where(
      parsed.kind === 'phone'
        ? eq(users.phoneE164, parsed.phoneE164)
        : eq(users.email, parsed.email)
    )
    .limit(1);

  if (found.length > 0 && found[0].isActive) {
    const user = found[0];
    const generated = generateSingleUseResetCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    await dbCtx.runInTransaction(async (tx) => {
      await tx.insert(passwordResetTokens).values({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: generated.tokenHash,
        issuedChannel: 'email_request',
        expiresAt,
        usedAt: null,
        createdAt: now,
      });

      await recordAuditEvent(tx, {
        actorUserId: user.id,
        eventType: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ipAddress ?? null,
        details: { hasEmail: Boolean(user.email) },
      });
    });
  }

  return { accepted: true };
}

/**
 * Resets a user's password using EITHER:
 * 1. Their personal Emergency Recovery Key (`SBRK-...`), OR
 * 2. A valid single-use 30-minute Reset Code (`SBRST-...`).
 *
 * Atomically revokes all active sessions, rotates the Emergency Recovery Key so
 * used keys cannot be replayed, and logs a security audit event.
 */
export async function confirmPasswordReset(
  dbCtx: DatabaseContext,
  input: {
    identifier: string;
    recoveryCode: string;
    newPassword: string;
    ipAddress?: string | null;
  }
): Promise<{
  resetCompleted: true;
  issuedRecoveryKey: string;
  recoveryCodeHint: string;
}> {
  let parsed: ReturnType<typeof parseAuthIdentifier>;
  try {
    parsed = parseAuthIdentifier(input.identifier);
  } catch (err) {
    toSafeIdentifierError(err);
  }

  validatePasswordStrength(input.newPassword);

  const normalizedCredential = normalizeRecoveryCredential(input.recoveryCode);
  if (normalizedCredential.length < 10) {
    throw new BadRequestError(
      'Enter your Emergency Recovery Key (SBRK-...) or Reset Code (SBRST-...).'
    );
  }

  const found = await dbCtx.db
    .select()
    .from(users)
    .where(
      parsed.kind === 'phone'
        ? eq(users.phoneE164, parsed.phoneE164)
        : eq(users.email, parsed.email)
    )
    .limit(1);

  const user = found[0];
  if (!user || !user.isActive) {
    await verifyDummyPassword(normalizedCredential);
    throw new AuthenticationError('Invalid account identifier or recovery code.');
  }

  const now = new Date();
  let matchedTokenId: string | null = null;
  let verifiedVia: 'reset_token' | 'emergency_recovery_key' | null = null;

  // 1. Check single-use time-limited reset token (SHA-256)
  const candidateTokenHash = sha256Hex(normalizedCredential);
  const tokenRows = await dbCtx.db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        eq(passwordResetTokens.tokenHash, candidateTokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now)
      )
    )
    .limit(1);

  if (tokenRows.length > 0) {
    matchedTokenId = tokenRows[0].id;
    verifiedVia = 'reset_token';
  } else if (user.recoveryCodeHash) {
    // 2. Check Emergency Recovery Key (scrypt)
    const validRecoveryKey = await verifyPassword(
      normalizedCredential,
      user.recoveryCodeHash
    );
    if (validRecoveryKey) {
      verifiedVia = 'emergency_recovery_key';
    }
  } else {
    await verifyDummyPassword(normalizedCredential);
  }

  if (!verifiedVia) {
    await recordAuditEvent(dbCtx.db, {
      actorUserId: user.id,
      eventType: 'auth.password_reset_failed',
      entityType: 'user',
      entityId: user.id,
      ipAddress: input.ipAddress ?? null,
    });
    throw new AuthenticationError('Invalid account identifier or recovery code.');
  }

  const newPasswordHash = await hashPassword(input.newPassword);
  const rotatedRecovery = await generateEmergencyRecoveryKey();

  await dbCtx.runInTransaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        recoveryCodeHash: rotatedRecovery.hash,
        recoveryCodeHint: rotatedRecovery.hint,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));

    // Invalidate all unused reset tokens for this user
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt)
        )
      );

    // Revoke every existing session for this user across all devices
    await tx
      .update(authSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt))
      );

    await recordAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'auth.password_reset_completed',
      entityType: 'user',
      entityId: user.id,
      ipAddress: input.ipAddress ?? null,
      details: {
        verifiedVia,
        matchedTokenId,
      },
    });
  });

  return {
    resetCompleted: true,
    issuedRecoveryKey: rotatedRecovery.rawKey,
    recoveryCodeHint: rotatedRecovery.hint,
  };
}

/**
 * Rotates an authenticated user's Emergency Recovery Key after re-verifying their current password.
 */
export async function rotateEmergencyRecoveryKey(
  dbCtx: DatabaseContext,
  input: {
    userId: string;
    shopId: string;
    currentPassword: string;
    ipAddress?: string | null;
  }
): Promise<{ issuedRecoveryKey: string; recoveryCodeHint: string }> {
  const rows = await dbCtx.db
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (rows.length === 0 || !rows[0].isActive) {
    throw new AuthenticationError('Account not found.');
  }

  const valid = await verifyPassword(input.currentPassword, rows[0].passwordHash);
  if (!valid) {
    throw new AuthenticationError('Current password is incorrect.');
  }

  const rotated = await generateEmergencyRecoveryKey();
  const now = new Date();

  await dbCtx.runInTransaction(async (tx) => {
    await tx
      .update(users)
      .set({
        recoveryCodeHash: rotated.hash,
        recoveryCodeHint: rotated.hint,
        updatedAt: now,
      })
      .where(eq(users.id, input.userId));

    await recordAuditEvent(tx, {
      shopId: input.shopId,
      actorUserId: input.userId,
      eventType: 'auth.recovery_code_rotated',
      entityType: 'user',
      entityId: input.userId,
      ipAddress: input.ipAddress ?? null,
    });
  });

  return {
    issuedRecoveryKey: rotated.rawKey,
    recoveryCodeHint: rotated.hint,
  };
}
