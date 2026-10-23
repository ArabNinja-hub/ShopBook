import { describe, expect, it } from 'vitest';
import {
  formatNgwee,
  formatNgweePlain,
  multiplyMoneyByQty,
  parseKwachaToNgwee,
  parseOptionalKwachaToNgwee,
  parseWholeUnits,
} from '../domain/money';
import { ValidationError } from '../domain/errors';

describe('Money & unit validation (integer ngwee)', () => {
  it('parses Kwacha strings without floating-point rounding bugs', () => {
    expect(parseKwachaToNgwee('12.50')).toBe(1250);
    expect(parseKwachaToNgwee('12.5')).toBe(1250);
    expect(parseKwachaToNgwee('12')).toBe(1200);
    expect(parseKwachaToNgwee('K12.50')).toBe(1250);
    expect(parseKwachaToNgwee('k 1,250.75')).toBe(125075);
    // Classic IEEE-754 floating-point trap: 19.99 * 100 === 1998.9999999999998 in float math
    expect(parseKwachaToNgwee('19.99')).toBe(1999);
    expect(parseKwachaToNgwee('0.05')).toBe(5);
    expect(parseKwachaToNgwee('0.99')).toBe(99);
  });

  it('rejects negative, zero (by default), blank, malformed, or huge monetary inputs', () => {
    expect(() => parseKwachaToNgwee('')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('   ')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('K')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('.50')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('0')).toThrow(ValidationError);
    expect(parseKwachaToNgwee('0', { allowZero: true })).toBe(0);
    expect(() => parseKwachaToNgwee('-5.00')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('12.555')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('1e3')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('99999999999.99')).toThrow(ValidationError);
    expect(() => parseKwachaToNgwee('abc')).toThrow(ValidationError);
  });

  it('handles optional cost price parsing cleanly', () => {
    expect(parseOptionalKwachaToNgwee('')).toBeNull();
    expect(parseOptionalKwachaToNgwee('   ')).toBeNull();
    expect(parseOptionalKwachaToNgwee(null)).toBeNull();
    expect(parseOptionalKwachaToNgwee('0')).toBe(0);
    expect(parseOptionalKwachaToNgwee('18.50')).toBe(1850);
    expect(() => parseOptionalKwachaToNgwee('-1.00')).toThrow(ValidationError);
  });

  it('formats integer ngwee consistently as K12.50 and rejects floats', () => {
    expect(formatNgwee(0)).toBe('K0.00');
    expect(formatNgwee(5)).toBe('K0.05');
    expect(formatNgwee(1250)).toBe('K12.50');
    expect(formatNgwee(125075)).toBe('K1,250.75');
    expect(formatNgwee(-2000)).toBe('-K20.00');
    expect(formatNgweePlain(125075)).toBe('1250.75');
    expect(() => formatNgwee(12.5)).toThrow(ValidationError);
    expect(() => formatNgwee(Number.NaN)).toThrow(ValidationError);
  });

  it('multiplies unit prices by whole-unit quantities accurately', () => {
    expect(multiplyMoneyByQty(1999, 3)).toBe(5997);
    expect(() => multiplyMoneyByQty(1250, 0)).toThrow(ValidationError);
    expect(() => multiplyMoneyByQty(1250, -2)).toThrow(ValidationError);
    expect(() => multiplyMoneyByQty(1250, 1.5)).toThrow(ValidationError);
  });

  it('strictly parses whole-unit quantities and prevents blank strings turning into 0', () => {
    expect(() => parseWholeUnits('', { allowZero: true })).toThrow(ValidationError);
    expect(() => parseWholeUnits('   ', { allowZero: true })).toThrow(ValidationError);
    expect(() => parseWholeUnits('2.5', { allowZero: true })).toThrow(ValidationError);
    expect(() => parseWholeUnits('1e2', { allowZero: true })).toThrow(ValidationError);
    expect(() => parseWholeUnits('-4', { allowZero: true })).toThrow(ValidationError);
    expect(() => parseWholeUnits('0', { allowZero: false })).toThrow(ValidationError);
    expect(parseWholeUnits('0', { allowZero: true })).toBe(0);
    expect(parseWholeUnits('25', { allowZero: false })).toBe(25);
  });
});
