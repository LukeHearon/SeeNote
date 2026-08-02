import { describe, it, expect } from 'vitest';
import {
  identityTimeline,
  buildSubsetTimeline,
  projectIntervalToDisplay,
} from '../utils/subsetTimeline';

describe('identityTimeline', () => {
  it('maps display and source to each other unchanged', () => {
    const tl = identityTimeline(120);
    expect(tl.identity).toBe(true);
    expect(tl.duration).toBe(120);
    for (const t of [0, 0.5, 37.25, 120]) {
      expect(tl.toDisplay(t)).toBeCloseTo(t, 12);
      expect(tl.toSource(t)).toBeCloseTo(t, 12);
    }
  });

  it('keeps everything and never clamps a drag', () => {
    const tl = identityTimeline(120);
    expect(tl.isKept(60)).toBe(true);
    expect(tl.clampToSpanOfDisplay(1, 119)).toBe(119);
  });
});

describe('buildSubsetTimeline', () => {
  it('merges touching ranges into one span', () => {
    const tl = buildSubsetTimeline(
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
      100,
    );
    expect(tl.spans).toHaveLength(1);
    expect(tl.spans[0]).toEqual({ srcStart: 0, srcEnd: 3, dispStart: 0 });
    expect(tl.duration).toBe(3);
  });

  it('merges overlapping and out-of-order ranges', () => {
    const tl = buildSubsetTimeline(
      [{ start: 5, end: 7 }, { start: 0, end: 2 }, { start: 6, end: 9 }],
      100,
    );
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([[0, 2], [5, 9]]);
    expect(tl.duration).toBe(6);
  });

  it('places each span end-to-end on the display axis', () => {
    const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);
    expect(tl.spans[0].dispStart).toBe(0);
    expect(tl.spans[1].dispStart).toBe(2);
    expect(tl.duration).toBe(5);
  });

  it('is the exact inverse of itself inside kept spans', () => {
    const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);
    for (const src of [10, 11, 11.999, 50, 51.5, 52.999]) {
      expect(tl.toSource(tl.toDisplay(src))).toBeCloseTo(src, 12);
    }
    for (const disp of [0, 1, 1.999, 2, 3.5, 4.999]) {
      expect(tl.toDisplay(tl.toSource(disp))).toBeCloseTo(disp, 12);
    }
  });

  it('makes cut-out time vanish from the display axis', () => {
    const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);
    // The 38s of hidden time between the spans costs nothing on screen: the
    // instant after the first span ends is the start of the second.
    expect(tl.toDisplay(12)).toBe(2);
    expect(tl.toDisplay(50)).toBe(2);
    expect(tl.toDisplay(30)).toBe(2); // in the gap → end of the preceding span
    expect(tl.toDisplay(5)).toBe(0);  // before the first span
    expect(tl.toDisplay(99)).toBe(5); // past the last span
  });

  it('reports what is kept', () => {
    const tl = buildSubsetTimeline([{ start: 10, end: 12 }], 100);
    expect(tl.isKept(10)).toBe(true);
    expect(tl.isKept(11.9)).toBe(true);
    expect(tl.isKept(12)).toBe(false);
    expect(tl.isKept(0)).toBe(false);
  });

  it('collapses to the identity timeline when nothing is actually hidden', () => {
    const tl = buildSubsetTimeline([{ start: 0, end: 100 }], 100);
    expect(tl.identity).toBe(true);
  });

  it('clamps ranges to the file and drops empty ones', () => {
    const tl = buildSubsetTimeline(
      [{ start: -5, end: 2 }, { start: 8, end: 8 }, { start: 95, end: 200 }],
      100,
    );
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([[0, 2], [95, 100]]);
  });

  it('yields an empty timeline when no range survives', () => {
    const tl = buildSubsetTimeline([], 100);
    expect(tl.duration).toBe(0);
    expect(tl.identity).toBe(false);
  });
});

describe('spansForDisplayRange', () => {
  const tl = buildSubsetTimeline(
    [{ start: 10, end: 12 }, { start: 50, end: 53 }, { start: 80, end: 81 }],
    100,
  );

  it('returns every span the viewport touches', () => {
    expect(tl.spansForDisplayRange(0, 6).map(s => s.srcStart)).toEqual([10, 50, 80]);
  });

  it('returns only the spans in range', () => {
    expect(tl.spansForDisplayRange(2.5, 4).map(s => s.srcStart)).toEqual([50]);
    expect(tl.spansForDisplayRange(0, 1).map(s => s.srcStart)).toEqual([10]);
  });
});

describe('clampToSpanOfDisplay', () => {
  const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);

  it('stops a drag at the edge of the span it started in', () => {
    // Anchored in the first span (display 0–2), dragging right past the cut.
    expect(tl.clampToSpanOfDisplay(0.5, 4)).toBe(2);
    // Anchored in the second span (display 2–5), dragging left past the cut.
    expect(tl.clampToSpanOfDisplay(3, 0)).toBe(2);
  });

  it('leaves a drag inside one span alone', () => {
    expect(tl.clampToSpanOfDisplay(0.5, 1.5)).toBe(1.5);
  });
});

describe('projectIntervalToDisplay', () => {
  const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);

  it('passes intervals through untouched on the identity timeline', () => {
    expect(projectIntervalToDisplay(identityTimeline(100), 3, 7)).toEqual({ start: 3, end: 7 });
  });

  it('maps an interval inside a kept span', () => {
    expect(projectIntervalToDisplay(tl, 10.5, 11.5)).toEqual({ start: 0.5, end: 1.5 });
  });

  it('clips an interval that runs past a cut to its own span', () => {
    // 11–51 covers hidden time; it must not appear to cover the second span.
    expect(projectIntervalToDisplay(tl, 11, 51)).toEqual({ start: 1, end: 2 });
  });

  it('hides an interval entirely inside cut-out time', () => {
    expect(projectIntervalToDisplay(tl, 20, 30)).toBeNull();
  });

  it('shows an interval that swallows a whole span', () => {
    expect(projectIntervalToDisplay(tl, 40, 60)).toEqual({ start: 2, end: 5 });
  });
});

describe('toSourceWithin', () => {
  const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);

  it('resolves a cut to the end of the anchor span, not the start of the next', () => {
    // Display 2 is both. Anchored in the first span it means source 12.
    expect(tl.toSourceWithin(0.5, 2)).toBe(12);
    // toSource alone picks the far side.
    expect(tl.toSource(2)).toBe(50);
  });

  it('clamps past the anchor span in both directions', () => {
    expect(tl.toSourceWithin(0.5, 9)).toBe(12);
    expect(tl.toSourceWithin(3, 0)).toBe(50);
  });

  it('agrees with toSource inside a span', () => {
    expect(tl.toSourceWithin(0.5, 1.5)).toBeCloseTo(tl.toSource(1.5), 12);
  });

  it('is plain clamping on the identity timeline', () => {
    expect(identityTimeline(100).toSourceWithin(0, 42)).toBe(42);
  });
});
