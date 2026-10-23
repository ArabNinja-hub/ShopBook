import { ValidationError } from '../domain/errors';

/**
 * Shared identifier normalization & validation for ShopBook accounts.
 *
 * Supports:
 * 1. Zambian mobile numbers across Airtel (097/077), MTN (096/076), and Zamtel (095/075)
 *    entered in local (0977123456) or international (+260977123456 / 260977123456) format,
 *    always normalized to canonical E.164 (`+2609XXXXXXXX` or `+2607XXXXXXXX`).
 * 2. Standard email addresses normalized to trimmed lowercase.
 */

const ZAMBIAN_SUBSCRIBER_REGEX = /^(9[567]|7[567])\d{7}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Normalizes a Zambian phone number into canonical E.164 format (`+260...`).
 * Throws `ValidationError` if the input is not a valid 9-digit Zambian mobile subscriber number.
 */
export function normalizeZambianPhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (!cleaned) {
    throw new ValidationError('Phone number cannot be empty.');
  }

  let subscriber = '';
  if (cleaned.startsWith('+260')) {
    subscriber = cleaned.slice(4);
  } else if (cleaned.startsWith('260') && cleaned.length === 12) {
    subscriber = cleaned.slice(3);
  } else if (cleaned.startsWith('0') && cleaned.length === 10) {
    subscriber = cleaned.slice(1);
  } else if (cleaned.length === 9 && /^[79]/.test(cleaned)) {
    subscriber = cleaned;
  } else {
    throw new ValidationError(
      'Enter a valid Zambian mobile number (e.g. 0977123456 or +260977123456).'
    );
  }

  if (!ZAMBIAN_SUBSCRIBER_REGEX.test(subscriber)) {
    throw new ValidationError(
      'Enter a valid Zambian mobile number on Airtel (097/077), MTN (096/076), or Zamtel (095/075).'
    );
  }

  return `+260${subscriber}`;
}

/**
 * Normalizes an email address to trimmed lowercase and validates its structure.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new ValidationError('Email address cannot be empty.');
  }
  if (trimmed.length > 254 || !EMAIL_REGEX.test(trimmed)) {
    throw new ValidationError('Enter a valid email address (e.g. owner@example.com).');
  }
  return trimmed;
}

export type ParsedIdentifier =
  | { kind: 'phone'; phoneE164: string; normalized: string }
  | { kind: 'email'; email: string; normalized: string };

/**
 * Parses a single login/recovery identifier field that can accept either a Zambian phone or an email.
 */
export function parseAuthIdentifier(raw: string): ParsedIdentifier {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError('Enter your Zambian phone number or email address.');
  }

  if (trimmed.includes('@')) {
    const email = normalizeEmail(trimmed);
    return { kind: 'email', email, normalized: email };
  }

  const phoneE164 = normalizeZambianPhone(trimmed);
  return { kind: 'phone', phoneE164, normalized: phoneE164 };
}

/**
 * Formats an E.164 Zambian number like `+260977123456` as `+260 977 123 456` for readable UI display.
 */
export function formatZambianPhoneReadable(phoneE164: string): string {
  const match = /^\+260(\d{3})(\d{3})(\d{3})$/.exec(phoneE164);
  if (!match) return phoneE164;
  return `+260 ${match[1]} ${match[2]} ${match[3]}`;
}
