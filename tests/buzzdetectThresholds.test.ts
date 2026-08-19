import { describe, it, expect } from 'vitest';
import { detectionThreshold } from '../utils/buzzdetectThresholds';
import { DEFAULT_BUZZDETECT_THRESHOLD } from '../constants';

// Three states in one map, and the distinction between the last two is the
// whole point: never set takes the default, deliberately cleared detects
// nothing.
describe('detectionThreshold', () => {
  it('takes the default when the neuron has no entry', () => {
    expect(detectionThreshold(undefined)).toBe(DEFAULT_BUZZDETECT_THRESHOLD);
  });

  it('passes a set threshold through, zero included', () => {
    expect(detectionThreshold(-1.5)).toBe(-1.5);
    expect(detectionThreshold(0)).toBe(0);
  });

  it('makes a cleared threshold unreachable', () => {
    expect(detectionThreshold(null)).toBe(Infinity);
    expect(1e308 >= detectionThreshold(null)).toBe(false);
  });
});
