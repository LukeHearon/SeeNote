import { describe, it, expect } from 'vitest';
import {
  lastStartAtOrBefore,
  firstStartAtOrAfter,
  binAtTime,
  visibleBinRange,
  firstFrameOverlapping,
  frameRangeForTimeSpan,
  bucketFrameRange,
} from '../utils/binIndex';

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

describe('firstStartAtOrAfter', () => {
  it('returns 0 before the first start', () => {
    expect(firstStartAtOrAfter(starts, -1)).toBe(0);
  });
  it('is inclusive of an exact start', () => {
    expect(firstStartAtOrAfter(starts, 1.92)).toBe(2);
  });
  it('rounds up between starts', () => {
    expect(firstStartAtOrAfter(starts, 1.0)).toBe(2);
  });
  it('returns length past the end', () => {
    expect(firstStartAtOrAfter(starts, 99)).toBe(starts.length);
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
  it('clamps a window past the end onto the last frame (the connecting neighbour)', () => {
    expect(visibleBinRange(starts, NARROW, 10, 15)).toEqual({ iLeft: 3, iRight: 4 });
  });
});

describe('firstFrameOverlapping', () => {
  it('returns the covering frame', () => {
    expect(firstFrameOverlapping(starts, FULL, 1.5)).toBe(1);
  });
  it('returns the next frame when t falls in a gap', () => {
    expect(firstFrameOverlapping(starts, NARROW, 1.5)).toBe(2);
  });
  it('returns 0 before the first frame', () => {
    expect(firstFrameOverlapping(starts, NARROW, -1)).toBe(0);
  });
  it('returns length past the end — callers choose clamp vs null', () => {
    expect(firstFrameOverlapping(starts, FULL, 10)).toBe(starts.length);
  });
});

describe('frameRangeForTimeSpan', () => {
  it('is half-open on the right: one frame selected reads as one frame', () => {
    // The selection a bin-mode drag produces for frame 1: [start, start+binWidth).
    expect(frameRangeForTimeSpan(starts, FULL, 0.96, 1.92)).toEqual({ start: 1, end: 1 });
  });
  it('tolerates a binWidth that overshoots the next frame start (f32 round-off)', () => {
    expect(frameRangeForTimeSpan(starts, FULL, 0.96, 1.9201)).toEqual({ start: 1, end: 1 });
  });
  it('covers every frame a multi-frame span starts in', () => {
    expect(frameRangeForTimeSpan(starts, FULL, 0.96, 3.84)).toEqual({ start: 1, end: 3 });
  });
  it('resolves a zero-length span to the containing frame', () => {
    expect(frameRangeForTimeSpan(starts, FULL, 1.5, 1.5)).toEqual({ start: 1, end: 1 });
  });
  it('returns null for a span entirely past the last frame', () => {
    // 5-frame CSV against a longer media file: 10–15s has no data at all, and
    // must not report the last frame's values as if it did.
    expect(frameRangeForTimeSpan(starts, FULL, 10, 15)).toBeNull();
    expect(frameRangeForTimeSpan(starts, NARROW, 10, 15)).toBeNull();
  });
  it('returns null before the first frame and inside a gap', () => {
    expect(frameRangeForTimeSpan(starts, FULL, -2, -1)).toBeNull();
    expect(frameRangeForTimeSpan(starts, NARROW, 1.4, 1.5)).toBeNull();
  });
  it('returns null with no data', () => {
    expect(frameRangeForTimeSpan([], FULL, 0, 1)).toBeNull();
  });
});

describe('bucketFrameRange', () => {
  it('groups every frame whose start falls in the bucket', () => {
    expect(bucketFrameRange(starts, 2, 0)).toEqual({ start: 0, end: 2 }); // 0, 0.96, 1.92
    expect(bucketFrameRange(starts, 2, 1)).toEqual({ start: 3, end: 4 }); // 2.88, 3.84
  });
  it('returns null for an empty bucket and for buckets past the end', () => {
    expect(bucketFrameRange(starts, 0.1, 5)).toBeNull(); // [0.5, 0.6): no frames
    expect(bucketFrameRange(starts, 2, 50)).toBeNull();
    expect(bucketFrameRange(starts, 2, -50)).toBeNull();
  });
  it('returns null with no data or a non-positive width', () => {
    expect(bucketFrameRange([], 2, 0)).toBeNull();
    expect(bucketFrameRange(starts, 0, 0)).toBeNull();
  });

  // The grouped polyline used to bucket with an incremental sweep while the
  // hover readout used a separate lookup, so the two could disagree about which
  // frames a drawn point covers. Both now call bucketFrameRange; this pins it
  // against the sweep the draw loop performed.
  it('matches the draw loop\'s incremental bucket sweep', () => {
    const sweep = (bucketWidth: number, firstBucket: number, lastBucket: number) => {
      const out: (string | null)[] = [];
      let j = firstStartAtOrAfter(starts, firstBucket * bucketWidth);
      for (let b = firstBucket; b <= lastBucket; b++) {
        const bStart = b * bucketWidth;
        const bEnd = bStart + bucketWidth;
        let first = -1;
        let last = -1;
        while (j < starts.length && starts[j] < bEnd) {
          if (starts[j] >= bStart) { if (first < 0) first = j; last = j; }
          j++;
        }
        out.push(first < 0 ? null : `${first}-${last}`);
      }
      return out;
    };
    for (const w of [0.5, 0.96, 1.3, 2, 5, 200]) {
      const first = -2;
      const last = Math.ceil(4 / w) + 2;
      const viaLookup = [];
      for (let b = first; b <= last; b++) {
        const r = bucketFrameRange(starts, w, b);
        viaLookup.push(r ? `${r.start}-${r.end}` : null);
      }
      expect(viaLookup).toEqual(sweep(w, first, last));
    }
  });
});
