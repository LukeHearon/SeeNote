import { describe, it, expect } from 'vitest';
import {
  lastStartAtOrBefore,
  firstStartAtOrAfter,
  binAtTime,
  visibleBinRange,
  firstFrameOverlapping,
  frameRangeForTimeSpan,
  bucketFrameRange,
  sourceBucketPieces,
  isGroupedUnitWidth,
  unitAtTime,
  forEachUnitInSpan,
  FrameUnit,
} from '../utils/binIndex';
import { buildSubsetTimeline, identityTimeline } from '../utils/subsetTimeline';

// Native 0.96s frames with the extent overridden to 0.4s: frames cover
// [0,0.4), [0.96,1.36), [1.92,2.32)… leaving 0.56s gaps between them.
const starts = [0, 0.96, 1.92, 2.88, 3.84];
const NARROW = 0.4;
const FULL = 0.96;
// Large enough duration that no test's [0, 4]-ish window ever gets clipped by
// the timeline's own file-length bound.
const ID = identityTimeline(1000);

// The unit functions take the whole frame grid (BuzzdetectData satisfies it
// structurally). Frame length and hop coincide unless a test says otherwise.
const grid = (frameLength: number, frameHop = frameLength, ss = starts) =>
  ({ starts: ss, frameLength, frameHop });

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
  it('returns null in the gaps left by a shortened frame length', () => {
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

describe('isGroupedUnitWidth', () => {
  it('reads a unit width at the frame hop as ungrouped, round-off included', () => {
    expect(isGroupedUnitWidth(FULL, FULL)).toBe(false);
    expect(isGroupedUnitWidth(FULL, FULL * 1.00005)).toBe(false);
    expect(isGroupedUnitWidth(FULL, FULL * 1.001)).toBe(true);
    expect(isGroupedUnitWidth(FULL, 5)).toBe(true);
  });
});

describe('unitAtTime', () => {
  it('resolves single frames when ungrouped, and nothing in the gaps', () => {
    // A frame's unit spans the frame's own extent, not the gap to the next one.
    expect(unitAtTime(ID, grid(NARROW), NARROW, 0.1)).toEqual({ start: 0, end: 0, tStart: 0, tEnd: NARROW });
    expect(unitAtTime(ID, grid(NARROW), NARROW, 0.5)).toBeNull();
    expect(unitAtTime(ID, grid(NARROW), NARROW, 1.0)).toEqual({ start: 1, end: 1, tStart: starts[1], tEnd: starts[1] + NARROW });
  });

  it('resolves the whole bucket when grouped', () => {
    // 2s buckets: [0,2) holds frames 0–2, [2,4) holds 3–4. The unit's extent is
    // the bucket's, not the frames' — that's the span the panel washes.
    expect(unitAtTime(ID, grid(FULL), 2, 0.5)).toEqual({ start: 0, end: 2, tStart: 0, tEnd: 2 });
    expect(unitAtTime(ID, grid(FULL), 2, 3.9)).toEqual({ start: 3, end: 4, tStart: 2, tEnd: 4 });
  });

  it('returns null for a bucket holding no frames', () => {
    expect(unitAtTime(ID, grid(FULL), 2, 100)).toBeNull();
  });

  // The whole point of the unit abstraction: the panel draws units and hit-tests
  // units, so a lookup at any time inside a drawn unit must return that unit.
  it('agrees with the units the draw loop enumerates', () => {
    for (const unitWidth of [NARROW, FULL, 1.3, 2, 5]) {
      const g = unitWidth === NARROW ? grid(NARROW) : grid(FULL);
      const drawn: FrameUnit[] = [];
      forEachUnitInSpan(ID, g, unitWidth, 0, 4, u => drawn.push(u));
      expect(drawn.length).toBeGreaterThan(0);
      for (const u of drawn) {
        for (const frac of [0.01, 0.5, 0.99]) {
          const t = u.tStart + (u.tEnd - u.tStart) * frac;
          if (t < 0 || t > 4) continue;
          expect(unitAtTime(ID, g, unitWidth, t)).toEqual(u);
        }
      }
    }
  });
});

describe('forEachUnitInSpan', () => {
  it('emits one unit per frame when ungrouped', () => {
    const out: FrameUnit[] = [];
    forEachUnitInSpan(ID, grid(FULL), FULL, 1.0, 2.0, u => out.push(u));
    // visibleBinRange widens by one frame each side.
    expect(out.map(u => u.start)).toEqual([0, 1, 2, 3]);
    expect(out.every(u => u.start === u.end)).toBe(true);
    expect(out[1].tStart).toBe(starts[1]);
    expect(out[1].tEnd).toBeCloseTo(starts[1] + FULL);
  });

  it('emits time-anchored buckets that do not re-partition as the span scrolls', () => {
    const bucketsFor = (t0: number, t1: number) => {
      const out: FrameUnit[] = [];
      forEachUnitInSpan(ID, grid(FULL), 2, t0, t1, u => out.push(u));
      return out;
    };
    const a = bucketsFor(0, 4);
    const b = bucketsFor(0.3, 4.3);
    for (const u of b) {
      const match = a.find(v => v.tStart === u.tStart);
      if (match) expect([match.start, match.end]).toEqual([u.start, u.end]);
    }
  });

  it('skips buckets with no frames rather than emitting empty ones', () => {
    const out: FrameUnit[] = [];
    forEachUnitInSpan(identityTimeline(200), grid(1, 1, [0, 100]), 1, 40, 60, u => out.push(u));
    expect(out.every(u => u.end >= u.start)).toBe(true);
  });

  it('emits nothing without data', () => {
    const out: FrameUnit[] = [];
    forEachUnitInSpan(ID, grid(1, 1, []), 1, 0, 10, u => out.push(u));
    expect(out).toEqual([]);
  });

  // The panel's unit width is published by the draw loop, so it reads as 0
  // until the first frame is drawn — that has to fall back to frames, not to
  // a division by zero.
  it('falls back to per-frame units for a zero unit width', () => {
    const out: FrameUnit[] = [];
    forEachUnitInSpan(ID, grid(FULL), 0, 0, 4, u => out.push(u));
    expect(out.every(u => u.start === u.end)).toBe(true);
    expect(unitAtTime(ID, grid(FULL), 0, 1.5)).toEqual({ start: 1, end: 1, tStart: starts[1], tEnd: starts[1] + FULL });
  });
});

describe('sourceBucketPieces / grouped units under a subset', () => {
  // Three 1s detections lifted out of a 300s file and butted together on
  // screen: display 0–1, 1–2, 2–3 are three different, far-apart parts of the
  // file (source 1–2, 4–5, 6–7). Frames are 1s, one per segment.
  const dispStarts = [0, 1, 2];
  const tl = buildSubsetTimeline([{ start: 1, end: 2 }, { start: 4, end: 5 }, { start: 6, end: 7 }], 300);

  it('passes a unit through untouched with no subset', () => {
    expect(sourceBucketPieces(identityTimeline(300), dispStarts, 3, 0)).toEqual([
      { start: 0, end: 2, tStart: 0, tEnd: 3 },
    ]);
  });

  it('cuts a bucket that (in file time) spans every segment into one piece per segment', () => {
    // Bucket 0 of width 10 is source [0,10) — all three detections fall
    // inside it — so this is the "one bin, several kept segments" case, cut
    // into one piece per segment rather than one band spanning all of them.
    const pieces = sourceBucketPieces(tl, dispStarts, 10, 0);
    expect(pieces).toEqual([
      { start: 0, end: 0, tStart: 0, tEnd: 1 },
      { start: 1, end: 1, tStart: 1, tEnd: 2 },
      { start: 2, end: 2, tStart: 2, tEnd: 3 },
    ]);
  });

  it('drops pieces holding no frame', () => {
    // Bucket source [30,40): past every segment, nothing to draw or select.
    expect(sourceBucketPieces(tl, dispStarts, 10, 3)).toEqual([]);
  });

  // The regression this whole module exists to prevent: a subset's display
  // axis is shifted by however much got cut before it, so flooring THAT axis
  // by the bucket width picks a different grid than the one the subset's own
  // criteria bucketed on (buzzdetectSubset.ts's detectionRanges) — producing
  // bucket edges that land wherever the display shift happens to put them,
  // not on any real boundary in the file. Buckets must come out anchored to
  // SOURCE time regardless of what was spliced out ahead of them.
  it('anchors bucket edges to file time, not the shifted display axis', () => {
    // Segments at source [1,3) and [5,7) (frames at source 1, 2, 5, 6) become
    // display [0,2) and [2,4) — contiguous on screen despite being 2s apart
    // in the file. A display-anchored 2-wide bucket grid would floor this
    // shifted axis into exactly [0,2) and [2,4), merging frame 1 with frame 2
    // (file time 1 and 2) and frame 5 with frame 6 (file time 5 and 6) — which
    // happens to look right here only because the shift is a whole bucket
    // width. Anchored to file time instead, width-2 buckets fall on the real
    // 0/2/4/6 grid: bucket 0 (source [0,2)) holds only frame at source 1;
    // bucket 1 (source [2,4)) holds only frame at source 2; and so on — never
    // pairing two frames from the same detection into one unit here.
    const twoSeg = buildSubsetTimeline([{ start: 1, end: 3 }, { start: 5, end: 7 }], 300);
    const twoSegStarts = [0, 1, 2, 3]; // display times for source 1, 2, 5, 6
    const atBucket = (b: number) => sourceBucketPieces(twoSeg, twoSegStarts, 2, b);
    expect(atBucket(0)).toEqual([{ start: 0, end: 0, tStart: 0, tEnd: 1 }]);
    expect(atBucket(1)).toEqual([{ start: 1, end: 1, tStart: 1, tEnd: 2 }]);
    expect(atBucket(2)).toEqual([{ start: 2, end: 2, tStart: 2, tEnd: 3 }]);
    expect(atBucket(3)).toEqual([{ start: 3, end: 3, tStart: 3, tEnd: 4 }]);

    // unitAtTime/forEachUnitInSpan must agree with this bucket-by-bucket view.
    for (const t of [0.5, 1.5, 2.5, 3.5]) {
      const viaLookup = unitAtTime(twoSeg, grid(1, 1, twoSegStarts), 2, t);
      expect(viaLookup).not.toBeNull();
      expect(viaLookup!.tEnd - viaLookup!.tStart).toBe(1);
    }
    const drawn: FrameUnit[] = [];
    forEachUnitInSpan(twoSeg, grid(1, 1, twoSegStarts), 2, 0, 4, u => drawn.push(u));
    expect(drawn.map(u => [u.tStart, u.tEnd])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
  });
});
