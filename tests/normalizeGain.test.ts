import { describe, it, expect } from 'vitest';
import { normalizationGain, NORMALIZE_TARGET_PEAK, MAX_NORMALIZE_GAIN } from '../utils/normalizeGain';

describe('normalizationGain', () => {
  it('brings a clip up to the target peak', () => {
    expect(normalizationGain(0.35)).toBeCloseTo(NORMALIZE_TARGET_PEAK / 0.35);
  });

  it('attenuates a hot clip below unity', () => {
    expect(normalizationGain(1.0)).toBeCloseTo(NORMALIZE_TARGET_PEAK);
    expect(normalizationGain(1.0)).toBeLessThan(1);
  });

  it('caps the boost for near-silent clips', () => {
    expect(normalizationGain(0.001)).toBe(MAX_NORMALIZE_GAIN);
  });

  it('returns unity for unusable peaks', () => {
    expect(normalizationGain(0)).toBe(1);
    expect(normalizationGain(-0.5)).toBe(1);
    expect(normalizationGain(NaN)).toBe(1);
    expect(normalizationGain(Infinity)).toBe(1);
  });
});
