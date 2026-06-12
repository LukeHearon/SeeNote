import { describe, it, expect } from 'vitest';
import { timeToX, xToTime, computeLabelPlacement, maxScroll, centerScrollLeft } from '../utils/viewportTransform';

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

describe('computeLabelPlacement', () => {
  const INSET = 8;

  it('places the label at the annotation start (plus inset) when fully on-screen and no selection', () => {
    // Annotation spans container px [100, 400]; no selection.
    const p = computeLabelPlacement({
      annStartX: 100,
      annEndX: 400,
      selStartX: null,
      selEndX: null,
      inset: INSET,
      textWidth: 40,
    });
    expect(p).toEqual({ leftX: 108, rightJustified: false });
  });

  it('pins the label to screen-left when the annotation start has scrolled off the left', () => {
    // Annotation start is off-screen (negative container x); end still visible.
    const p = computeLabelPlacement({
      annStartX: -250,
      annEndX: 400,
      selStartX: null,
      selEndX: null,
      inset: INSET,
      textWidth: 40,
    });
    // Pinned to the viewport-left inset, not annStartX + inset.
    expect(p).toEqual({ leftX: 8, rightJustified: false });
  });

  it('pops the label to the selection start when a selection overlaps the annotation', () => {
    // Annotation [100, 600]; selection starts at container x = 300 inside it.
    const p = computeLabelPlacement({
      annStartX: 100,
      annEndX: 600,
      selStartX: 300,
      selEndX: 450,
      inset: INSET,
      textWidth: 60,
    });
    expect(p).toEqual({ leftX: 306, rightJustified: false });
  });

  it('takes the rightmost of the screen-left pin and the selection start', () => {
    // Annotation start off-screen at -50, but selection start at 200 is further
    // right, so the selection wins.
    const p = computeLabelPlacement({
      annStartX: -50,
      annEndX: 600,
      selStartX: 200,
      selEndX: 350,
      inset: INSET,
      textWidth: 60,
    });
    expect(p).toEqual({ leftX: 206, rightJustified: false });
  });

  it('ignores a selection that does not overlap the annotation', () => {
    // Selection [700, 800] is entirely to the right of annotation [100, 400].
    const p = computeLabelPlacement({
      annStartX: 100,
      annEndX: 400,
      selStartX: 700,
      selEndX: 800,
      inset: INSET,
      textWidth: 40,
    });
    expect(p).toEqual({ leftX: 108, rightJustified: false });
  });

  it('right-justifies against the annotation end when the popped label has no room for the text', () => {
    // Annotation [100, 400]; selection starts at 360, close to the end. Text is
    // 100px wide and cannot fit between 360 and (400 - 8) = 392.
    const p = computeLabelPlacement({
      annStartX: 100,
      annEndX: 400,
      selStartX: 360,
      selEndX: 380,
      inset: INSET,
      textWidth: 100,
    });
    // Right edge pinned to annEndX - inset = 392; left = 392 - 100 = 292.
    expect(p).toEqual({ leftX: 292, rightJustified: true });
  });

  it('does not apply the right-justify fallback when text width is unknown (0)', () => {
    const p = computeLabelPlacement({
      annStartX: 100,
      annEndX: 400,
      selStartX: 360,
      selEndX: 380,
      inset: INSET,
      textWidth: 0,
    });
    expect(p).toEqual({ leftX: 366, rightJustified: false });
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
