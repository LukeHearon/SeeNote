import { describe, it, expect } from 'vitest';
import { timeToX, xToTime, maxScroll, centerScrollLeft } from '../utils/viewportTransform';

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

describe('centerScrollLeft', () => {
  // 100 px/s, 1000px viewport (=10s window), 60s file.
  const pps = 100;
  const width = 1000;
  const duration = 60;

  it('centers the playhead mid-file', () => {
    // t=30s → ideal scroll puts 30s at the viewport center (500px in).
    // scroll = 30*100 - 1000/2 = 2500. Left edge = 2500/100 = 25s, so the
    // window spans 25–35s and the playhead sits at the center.
    expect(centerScrollLeft(30, pps, width, duration)).toBe(2500);
    expect(timeToX(30, 2500, pps)).toBe(width / 2);
  });

  it('clamps to 0 near the start (never scrolls before the file)', () => {
    // t=2s would want scroll = 200 - 500 = -300; clamped to 0.
    expect(centerScrollLeft(2, pps, width, duration)).toBe(0);
  });

  it('clamps to maxScroll near the end (never past the end overrun)', () => {
    const max = maxScroll(duration, pps, width);
    // max = 60*100 - 1000 + 400 = 5400.
    expect(max).toBe(5400);
    // t=60s would want scroll = 6000 - 500 = 5500; clamped to 5400.
    expect(centerScrollLeft(60, pps, width, duration)).toBe(5400);
  });

  it('pins to 0 when the whole file fits in the viewport', () => {
    // 5s file at 100px/s = 500px < 1000px viewport → maxScroll is 0.
    expect(maxScroll(5, pps, width)).toBe(0);
    expect(centerScrollLeft(3, pps, width, 5)).toBe(0);
  });
});
