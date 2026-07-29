import { describe, it, expect } from 'vitest';
import {
  buildPrefixSum,
  buildThresholdCountPrefix,
  buildAnyOverThresholdPrefix,
  rangeSum,
  rangeMean,
} from '../utils/prefixSums';

const values = [1, 2, 3, 4, 5];

describe('buildPrefixSum', () => {
  it('is one longer than the input and starts at zero', () => {
    const p = buildPrefixSum(values);
    expect(p.length).toBe(values.length + 1);
    expect(p[0]).toBe(0);
  });
  it('accumulates', () => {
    expect(Array.from(buildPrefixSum(values))).toEqual([0, 1, 3, 6, 10, 15]);
  });
  it('handles an empty series', () => {
    expect(Array.from(buildPrefixSum([]))).toEqual([0]);
  });
});

describe('buildThresholdCountPrefix', () => {
  it('counts entries at or above the threshold', () => {
    expect(Array.from(buildThresholdCountPrefix(values, 3))).toEqual([0, 0, 0, 1, 2, 3]);
  });
  it('is inclusive of an exact threshold hit', () => {
    expect(rangeSum(buildThresholdCountPrefix([3], 3), 0, 0)).toBe(1);
  });
});

describe('buildAnyOverThresholdPrefix', () => {
  it('ORs across series rather than summing them', () => {
    // Both neurons clear on frame 2 — one detected frame, not two.
    const p = buildAnyOverThresholdPrefix(
      [
        { values: [0, 1, 1, 0], threshold: 1 },
        { values: [0, 0, 1, 0], threshold: 1 },
      ],
      4,
    );
    expect(Array.from(p)).toEqual([0, 0, 1, 2, 2]);
  });
  it('counts nothing when no series is enabled', () => {
    expect(Array.from(buildAnyOverThresholdPrefix([], 3))).toEqual([0, 0, 0, 0]);
  });
});

describe('rangeSum / rangeMean', () => {
  const p = buildPrefixSum(values);
  it('is inclusive on both ends', () => {
    expect(rangeSum(p, 1, 3)).toBe(9);
    expect(rangeMean(p, 1, 3)).toBe(3);
  });
  it('handles a single-element range', () => {
    expect(rangeSum(p, 4, 4)).toBe(5);
    expect(rangeMean(p, 4, 4)).toBe(5);
  });
  it('covers the whole series', () => {
    expect(rangeSum(p, 0, values.length - 1)).toBe(15);
  });
  it('returns 0 for an inverted range instead of NaN', () => {
    expect(rangeSum(p, 3, 2)).toBe(0);
    expect(rangeMean(p, 3, 2)).toBe(0);
  });
  it('matches a naive scan', () => {
    for (let a = 0; a < values.length; a++) {
      for (let b = a; b < values.length; b++) {
        let sum = 0;
        for (let k = a; k <= b; k++) sum += values[k];
        expect(rangeSum(p, a, b)).toBe(sum);
        expect(rangeMean(p, a, b)).toBeCloseTo(sum / (b - a + 1), 12);
      }
    }
  });
});
