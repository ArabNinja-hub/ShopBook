import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

const CROCKFORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function scryptDerivedKey(
  secret: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      secret.normalize('NFKC'),
      salt,
      keylen,
      { N, r, p, maxmem: SCRYPT_MAXMEM },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });
}

/**
 * Hashes a user password or recovery key using memory-hard `scrypt` with a 128-bit random salt.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptDerivedKey(
    password,
    salt,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEYLEN
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verifies a password or recovery key in constant time using `crypto.timingSafeEqual`.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const expectedHex = parts[5];

  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    !saltHex ||
    !expectedHex
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  try {
    const derived = await scryptDerivedKey(
      password,
      salt,
      N,
      r,
      p,
      expected.length
    );
    if (derived.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Precomputed dummy scrypt hash used when an account does not exist to prevent timing enumeration
const DUMMY_HASH_SALT = Buffer.alloc(16, 0x5a).toString('hex');
const DUMMY_HASH_VAL = Buffer.alloc(SCRYPT_KEYLEN, 0xa5).toString('hex');
const DUMMY_SCRYPT_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${DUMMY_HASH_SALT}$${DUMMY_HASH_VAL}`;

export async function verifyDummyPassword(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_SCRYPT_HASH);
}

/**
 * SHA-256 hex digest for opaque session tokens and one-time reset tokens.
 * Raw tokens are sent only to the user/client; only the SHA-256 digest is stored in PostgreSQL.
 */
export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateSessionToken(): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: sha256Hex(rawToken),
  };
}

function randomAlphabetChars(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
  }
  return out;
}

export function normalizeRecoveryCredential(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-]/g, '');
}

/**
 * Generates an owner Emergency Recovery Key (`SBRK-XXXX-XXXX-XXXX`, 60-bit entropy).
 * Stored hashed with `scrypt`; never stored in plaintext.
 */
export async function generateEmergencyRecoveryKey(): Promise<{
  rawKey: string;
  hash: string;
  hint: string;
}> {
  const g1 = randomAlphabetChars(4);
  const g2 = randomAlphabetChars(4);
  const g3 = randomAlphabetChars(4);
  const rawKey = `SBRK-${g1}-${g2}-${g3}`;
  const normalized = normalizeRecoveryCredential(rawKey);
  const hash = await hashPassword(normalized);
  const hint = `SBRK-••••-••••-${g3}`;
  return { rawKey, hash, hint };
}

/**
 * Generates a single-use, time-limited Password Reset Code (`SBRST-XXXX-XXXX-XXXX`).
 * Stored as SHA-256 digest in `password_reset_tokens`.
 */
export function generateSingleUseResetCode(): {
  rawCode: string;
  tokenHash: string;
} {
  const g1 = randomAlphabetChars(4);
  const g2 = randomAlphabetChars(4);
  const g3 = randomAlphabetChars(4);
  const rawCode = `SBRST-${g1}-${g2}-${g3}`;
  const normalized = normalizeRecoveryCredential(rawCode);
  return {
    rawCode,
    tokenHash: sha256Hex(normalized),
  };
}
