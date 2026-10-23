import { ValidationError } from './errors';

/**
 * Money utilities for Zambian Kwacha (ZMW).
 *
 * IMPORTANT RULE:
 * All monetary amounts in ShopBook are stored and calculated as INTEGER NGWEE
 * (1 Kwacha = 100 ngwee). For example, K12.50 is stored as `1250`.
 * Never use floating-point math (`parseFloat(x) * 100`) to avoid rounding errors.
 */

/** Sanity limit: K10,000,000.00 (1,000,000,000 ngwee) per single item or entry */
export const MAX_MONEY_NGWEE = 1_000_000_000;

/**
 * Asserts that a number is a valid non-negative integer ngwee value.
 */
export function assertValidNgwee(
  ngwee: number,
  fieldLabel = 'Amount',
  allowZero = false
): void {
  if (!Number.isSafeInteger(ngwee)) {
    throw new ValidationError(`${fieldLabel} must be a whole ngwee integer.`);
  }
  if (allowZero ? ngwee < 0 : ngwee <= 0) {
    throw new ValidationError(
      allowZero
        ? `${fieldLabel} cannot be negative.`
        : `${fieldLabel} must be greater than K0.00.`
    );
  }
  if (ngwee > MAX_MONEY_NGWEE) {
    throw new ValidationError(`${fieldLabel} exceeds the maximum allowed amount.`);
  }
}

/**
 * Parses a user-entered Kwacha string (such as "12.50", "12.5", "12", "K12.50", "1,250.00")
 * into exact integer ngwee without floating-point arithmetic.
 */
export function parseKwachaToNgwee(
  rawInput: string,
  options: { fieldLabel?: string; allowZero?: boolean } = {}
): number {
  const fieldLabel = options.fieldLabel ?? 'Amount';
  const allowZero = options.allowZero ?? false;

  const cleaned = rawInput.trim().replace(/^K\s*/i, '').replace(/,/g, '');
  if (!cleaned) {
    throw new ValidationError(`${fieldLabel} is required.`);
  }

  if (cleaned.startsWith('-')) {
    throw new ValidationError(`${fieldLabel} cannot be negative.`);
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new ValidationError(
      `${fieldLabel} must be a valid Kwacha amount with up to 2 decimal places (for example, 12.50).`
    );
  }

  const kwachaWhole = Number(match[1]);
  const ngweeFractionStr = (match[2] ?? '').padEnd(2, '0');
  const ngweeFraction = Number(ngweeFractionStr);

  if (!Number.isSafeInteger(kwachaWhole) || !Number.isSafeInteger(ngweeFraction)) {
    throw new ValidationError(`${fieldLabel} is too large.`);
  }

  const totalNgwee = kwachaWhole * 100 + ngweeFraction;
  assertValidNgwee(totalNgwee, fieldLabel, allowZero);
  return totalNgwee;
}

/**
 * Parses an optional Kwacha input string (e.g. optional Cost Price).
 * Returns `null` when blank, or validated integer ngwee when provided.
 */
export function parseOptionalKwachaToNgwee(
  rawInput: string | null | undefined,
  fieldLabel = 'Cost price'
): number | null {
  if (rawInput === null || rawInput === undefined || rawInput.trim() === '') {
    return null;
  }
  return parseKwachaToNgwee(rawInput, { fieldLabel, allowZero: true });
}

/**
 * Formats integer ngwee for display in Zambian Kwacha, e.g. `1250` -> `"K12.50"`,
 * `125000` -> `"K1,250.00"`, `-500` -> `"-K5.00"`.
 */
export function formatNgwee(ngwee: number): string {
  if (!Number.isSafeInteger(ngwee)) {
    throw new ValidationError(`Cannot format non-integer ngwee value: ${ngwee}`);
  }
  const isNegative = ngwee < 0;
  const abs = Math.abs(ngwee);
  const kwacha = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const kwachaFormatted = kwacha.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${isNegative ? '-' : ''}K${kwachaFormatted}.${cents}`;
}

/**
 * Formats integer ngwee as a plain numeric string without currency prefix or commas,
 * e.g. `1250` -> `"12.50"`. Useful for pre-filling form inputs and CSV number columns.
 */
export function formatNgweePlain(ngwee: number): string {
  if (!Number.isSafeInteger(ngwee)) {
    throw new ValidationError(`Cannot format non-integer ngwee value: ${ngwee}`);
  }
  const isNegative = ngwee < 0;
  const abs = Math.abs(ngwee);
  const kwacha = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${isNegative ? '-' : ''}${kwacha}.${cents}`;
}

/**
 * Multiplies a unit price in ngwee by a positive whole-unit quantity.
 */
export function multiplyMoneyByQty(unitPriceNgwee: number, quantity: number): number {
  assertValidNgwee(unitPriceNgwee, 'Unit price', true);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new ValidationError('Quantity must be a whole number greater than zero.');
  }
  const result = unitPriceNgwee * quantity;
  if (!Number.isSafeInteger(result) || result > MAX_MONEY_NGWEE * 10) {
    throw new ValidationError('Line total exceeds maximum allowed amount.');
  }
  return result;
}

/**
 * Strictly parses a whole-unit integer input string (e.g. stock quantity or threshold).
 * Rejects blank strings (avoiding JavaScript's `Number("") === 0` pitfall),
 * decimals, negative numbers, and scientific notation.
 */
export function parseWholeUnits(
  rawInput: string,
  options: { fieldLabel?: string; allowZero?: boolean; maxUnits?: number } = {}
): number {
  const fieldLabel = options.fieldLabel ?? 'Quantity';
  const allowZero = options.allowZero ?? false;
  const maxUnits = options.maxUnits ?? 1_000_000;

  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new ValidationError(`${fieldLabel} is required.`);
  }
  if (trimmed.startsWith('-')) {
    throw new ValidationError(`${fieldLabel} cannot be negative.`);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationError(`${fieldLabel} must be a whole number (no decimals).`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > maxUnits) {
    throw new ValidationError(`${fieldLabel} is too large.`);
  }
  if (!allowZero && parsed <= 0) {
    throw new ValidationError(`${fieldLabel} must be greater than 0.`);
  }
  return parsed;
}
