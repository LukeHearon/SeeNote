import { describe, it, expect } from 'vitest';
import { formatGrouped } from '../utils/numberFormat';

describe('formatGrouped', () => {
  it('groups thousands and defaults to no fraction digits', () => {
    expect(formatGrouped(8320)).toBe('8,320');
    expect(formatGrouped(0)).toBe('0');
    expect(formatGrouped(999)).toBe('999');
    expect(formatGrouped(1234567)).toBe('1,234,567');
  });

  it('pads and rounds to the requested fraction digits', () => {
    expect(formatGrouped(83.4, 2)).toBe('83.40');
    expect(formatGrouped(0, 2)).toBe('0.00');
    expect(formatGrouped(1234.5678, 2)).toBe('1,234.57');
    expect(formatGrouped(1234.5678, 0)).toBe('1,235');
  });

  it('matches the toLocaleString calls it replaced', () => {
    // The cached formatters must be indistinguishable from the per-call
    // construction they stand in for, decimals-by-decimals.
    for (const decimals of [0, 1, 2, 3]) {
      for (const v of [0, 1, 83.4, 999.999, 8320, 1234567.891]) {
        expect(formatGrouped(v, decimals)).toBe(
          v.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }),
        );
      }
    }
  });

  it('keeps one formatter per decimal count across calls', () => {
    // Repeat calls must stay stable — a cache keyed wrong would leak the
    // previous call's fraction digits into the next.
    expect(formatGrouped(5, 2)).toBe('5.00');
    expect(formatGrouped(5)).toBe('5');
    expect(formatGrouped(5, 2)).toBe('5.00');
  });

  it('handles negatives the same way as the platform formatter', () => {
    expect(formatGrouped(-1234.5, 1)).toBe('-1,234.5');
  });
});
