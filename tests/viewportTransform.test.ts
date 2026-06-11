import { describe, it, expect } from 'vitest';
import { timeToX, xToTime } from '../utils/viewportTransform';

describe('viewportTransform', () => {
  it('timeToX maps time to pixels relative to the scroll offset', () => {
    // 100 px/s, scrolled 50px: t=1s lands at 100 - 50 = 50px.
    expect(timeToX(1, 50, 100)).toBe(50);
    // The left edge of the viewport corresponds to scrollLeft / pps.
    expect(timeToX(0.5, 50, 100)).toBe(0);
  });

  it('xToTime is the exact inverse of timeToX', () => {
    const scrollLeft = 137.5;
    const pps = 83.25;
    for (const t of [0, 0.25, 1, 12.3456, 999.999]) {
      const x = timeToX(t, scrollLeft, pps);
      expect(xToTime(x, scrollLeft, pps)).toBeCloseTo(t, 9);
    }
  });

  it('xToTime maps pixels back to absolute time', () => {
    // x=0 at scrollLeft=50, pps=100 -> 0.5s.
    expect(xToTime(0, 50, 100)).toBeCloseTo(0.5, 9);
    expect(xToTime(150, 50, 100)).toBeCloseTo(2, 9);
  });
});
