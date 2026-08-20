import { describe, it, expect } from 'vitest';
import { detectionThreshold } from '../utils/buzzdetectThresholds';
import { INS_BUZZ_DEFAULT_THRESHOLD } from '../constants';

// Three states in one map, and the distinction between the last two is the
// whole point: never set takes the default, deliberately cleared detects
// nothing.
describe('detectionThreshold', () => {
  it('takes no threshold by default', () => {
    expect(detectionThreshold(undefined, 'wasp')).toBe(Infinity);
  });

  it('defaults ins_buzz to its pretrained boundary', () => {
    expect(detectionThreshold(undefined, 'ins_buzz')).toBe(INS_BUZZ_DEFAULT_THRESHOLD);
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
