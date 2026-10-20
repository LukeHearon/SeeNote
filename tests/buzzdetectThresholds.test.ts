import { describe, it, expect } from 'vitest';
import { baselineOffset, detectionThreshold } from '../utils/buzzdetectThresholds';

// Three states in one map, and the distinction between the last two is the
// whole point: never set takes the default, deliberately cleared detects
// nothing.
describe('detectionThreshold', () => {
  it('defaults every neuron to 0, ins_buzz included', () => {
    expect(detectionThreshold(undefined, 'wasp')).toBe(0);
    expect(detectionThreshold(undefined, 'ins_buzz')).toBe(0);
  });

  it('passes a set threshold through, zero included', () => {
    expect(detectionThreshold(-1.5, 'wasp')).toBe(-1.5);
    expect(detectionThreshold(0, 'wasp')).toBe(0);
  });

  it('makes a cleared threshold unreachable, even for ins_buzz', () => {
    expect(detectionThreshold(null, 'wasp')).toBe(Infinity);
    expect(detectionThreshold(null, 'ins_buzz')).toBe(Infinity);
    expect(1e308 >= detectionThreshold(null, 'wasp')).toBe(false);
  });
});

describe('baselineOffset', () => {
  it('shifts by the threshold only when adjusted', () => {
    expect(baselineOffset(1.5, true)).toBe(1.5);
    expect(baselineOffset(-2, true)).toBe(-2);
    expect(baselineOffset(1.5, false)).toBe(0);
  });

  it('leaves a neuron with no threshold unshifted', () => {
    expect(baselineOffset(Infinity, true)).toBe(0);
  });
});
