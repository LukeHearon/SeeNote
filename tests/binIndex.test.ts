import { describe, it, expect } from 'vitest';
import { lastStartAtOrBefore, binAtTime, visibleBinRange } from '../utils/binIndex';

// Native 0.96s frames with the extent overridden to 0.4s: frames cover
// [0,0.4), [0.96,1.36), [1.92,2.32)… leaving 0.56s gaps between them.
const starts = [0, 0.96, 1.92, 2.88, 3.84];
const NARROW = 0.4;
const FULL = 0.96;

describe('lastStartAtOrBefore', () => {
  it('returns -1 before the first start', () => {
    expect(lastStartAtOrBefore(starts, -0.1)).toBe(-1);
  });
  it('is inclusive of an exact start', () => {
    expect(lastStartAtOrBefore(starts, 1.92)).toBe(2);
  });
  it('returns the last index past the end', () => {
    expect(lastStartAtOrBefore(starts, 99)).toBe(4);
  });
});

describe('binAtTime', () => {
  it('finds the covering frame with contiguous bins', () => {
    expect(binAtTime(starts, FULL, 1.5)).toBe(1);
  });
  it('returns null in the gaps left by a shortened binWidth', () => {
    expect(binAtTime(starts, NARROW, 1.0)).toBe(1);   // just inside frame 1
    expect(binAtTime(starts, NARROW, 1.5)).toBeNull(); // in the gap
    expect(binAtTime(starts, NARROW, 1.36)).toBeNull(); // half-open at the end
  });
  it('returns null before the first frame and after the last', () => {
    expect(binAtTime(starts, NARROW, -1)).toBeNull();
    expect(binAtTime(starts, NARROW, 10)).toBeNull();
  });
});

describe('visibleBinRange', () => {
  it('covers the window plus one frame of margin each side', () => {
    expect(visibleBinRange(starts, NARROW, 1.9, 2.9)).toEqual({ iLeft: 1, iRight: 4 });
  });
  it('does not depend on binWidth matching the frame spacing', () => {
    // The arithmetic version scaled indices by 1/binWidth and skipped frames.
    expect(visibleBinRange(starts, NARROW, 0, 3.9)).toEqual({ iLeft: 0, iRight: 4 });
    expect(visibleBinRange(starts, FULL, 0, 3.9)).toEqual({ iLeft: 0, iRight: 4 });
  });
  it('drops frames entirely left of the window (beyond the margin)', () => {
    expect(visibleBinRange(starts, NARROW, 3.0, 4.0)!.iLeft).toBe(2);
  });
  it('returns null with no data', () => {
    expect(visibleBinRange([], NARROW, 0, 1)).toBeNull();
  });
});
