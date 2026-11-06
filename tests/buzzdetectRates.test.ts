import { describe, it, expect } from 'vitest';
import { maxUnitRates, niceRateCeiling, formatRatePercent } from '../utils/buzzdetectRates';
import { buildThresholdCountPrefix, buildValidCountPrefix } from '../utils/prefixSums';
import { identityTimeline } from '../utils/subsetTimeline';

describe('niceRateCeiling', () => {
  it('rounds up to a tidy ceiling with a little headroom', () => {
    expect(niceRateCeiling(0.08)).toBe(0.1);
    expect(niceRateCeiling(0.5)).toBe(0.6);
    expect(niceRateCeiling(0.012)).toBe(0.015);
    expect(niceRateCeiling(0.0009)).toBe(0.001);
  });
  it('caps at 1 and falls back to 1 with nothing to fit', () => {
    expect(niceRateCeiling(0.97)).toBe(1);
    expect(niceRateCeiling(1)).toBe(1);
    expect(niceRateCeiling(0)).toBe(1);
    expect(niceRateCeiling(NaN)).toBe(1);
  });
});

describe('formatRatePercent', () => {
  it('shows only the places a value needs', () => {
    expect(formatRatePercent(0.025)).toBe('2.5%');
    expect(formatRatePercent(0.1)).toBe('10%');
    expect(formatRatePercent(0)).toBe('0%');
  });
});

describe('maxUnitRates', () => {
  // Ten 1s frames, bins of 5s: bin 0 = frames 0-4, bin 1 = frames 5-9.
  const starts = Array.from({ length: 10 }, (_, i) => i);
  const grid = { starts, frameLength: 1, frameHop: 1 };
  const tl = identityTimeline(10);

  it('takes each neuron\'s highest bin rate across the whole file', () => {
    const a = [1, 0, 0, 0, 0, 1, 1, 1, 0, 0]; // bins: 0.2, 0.6
    const b = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // bins: 0, 0.2
    const det = [a, b].map(v => buildThresholdCountPrefix(v, 0.5));
    const valid = [a, b].map(v => buildValidCountPrefix(v));
    const r = maxUnitRates(tl, grid, 5, 0, 10, [0, 1], det, valid);
    expect(r[0]).toBeCloseTo(0.6);
    expect(r[1]).toBeCloseTo(0.2);
  });

  it('only looks inside the span, and only at the neurons asked for', () => {
    const a = [1, 0, 0, 0, 0, 1, 1, 1, 0, 0]; // bins: 0.2, 0.6
    const b = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]; // bins: 1, 0
    const det = [a, b].map(v => buildThresholdCountPrefix(v, 0.5));
    const valid = [a, b].map(v => buildValidCountPrefix(v));
    const r = maxUnitRates(tl, grid, 5, 0, 4, [0], det, valid);
    expect(r[0]).toBeCloseTo(0.2);
    expect(r[1]).toBe(0);
  });

  it('divides by the frames that had a value', () => {
    const a = [1, NaN, NaN, NaN, NaN, 0, 0, 0, 0, 0]; // bin 0: 1 of 1 valid
    const det = [buildThresholdCountPrefix(a, 0.5)];
    const r = maxUnitRates(tl, grid, 5, 0, 10, [0], det, [buildValidCountPrefix(a)]);
    expect(r[0]).toBeCloseTo(1);
  });

  it('is 0 for a neuron that never detects', () => {
    const a = Array(10).fill(0);
    const r = maxUnitRates(tl, grid, 5, 0, 10, [0], [buildThresholdCountPrefix(a, 0.5)], [buildValidCountPrefix(a)]);
    expect(r[0]).toBe(0);
  });
});
