// Index lookups over buzzdetect frame starts.
//
// Frames are NOT necessarily contiguous: `binWidth` is the extent of a frame
// and may be overridden (project setting) to something shorter than the native
// spacing between `starts`. A 0.4s override on a model with 0.96s hops leaves
// 0.56s of uncovered time between frames. So frame position must always be read
// from `starts` — never reconstructed as `starts[0] + i * binWidth`, which is
// only correct in the fully-contiguous case.
//
// `starts` is ascending, so every lookup here is a binary search.

import type { Timeline } from './subsetTimeline';

/** Index of the last start <= t, or -1 if t precedes every start. */
export function lastStartAtOrBefore(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Index of the first start >= t, or starts.length if every start precedes t. */
export function firstStartAtOrAfter(starts: number[], t: number): number {
  const i = lastStartAtOrBefore(starts, t);
  if (i < 0) return 0;
  return starts[i] >= t ? i : i + 1;
}

/**
 * The frame covering time `t`, or null when `t` falls in a gap between frames
 * (or outside the data). Half-open: [start, start + binWidth).
 */
export function binAtTime(starts: number[], binWidth: number, t: number): number | null {
  const i = lastStartAtOrBefore(starts, t);
  if (i < 0) return null;
  return t < starts[i] + binWidth ? i : null;
}

/**
 * Index of the first frame whose extent reaches past `t` — i.e. the frame
 * covering `t`, or the next one when `t` falls in a gap. Returns
 * `starts.length` when `t` is past the end of the data; callers decide whether
 * that means "clamp to the last frame" or "nothing here".
 */
export function firstFrameOverlapping(starts: number[], binWidth: number, t: number): number {
  const i = lastStartAtOrBefore(starts, t);
  if (i < 0) return 0;
  return starts[i] + binWidth <= t ? i + 1 : i;
}

/**
 * Inclusive index range of frames intersecting [t0, t1], widened by one frame
 * on each side so polylines connect to off-screen neighbours. Returns null when
 * nothing intersects.
 */
export function visibleBinRange(
  starts: number[],
  binWidth: number,
  t0: number,
  t1: number,
): { iLeft: number; iRight: number } | null {
  if (starts.length === 0) return null;
  // Last frame that can still reach into the window, then one extra for the
  // connecting line segment.
  const iRight = Math.min(starts.length - 1, lastStartAtOrBefore(starts, t1) + 1);
  // First frame whose extent ends after t0 — i.e. skip frames entirely left of
  // the window — then one extra to connect. A window entirely past the data
  // clamps to the last frame here, which is what the draw loop wants: it still
  // has to connect back to that off-screen neighbour.
  const iLeft = Math.max(0, Math.min(firstFrameOverlapping(starts, binWidth, t0), starts.length - 1) - 1);
  if (iLeft > iRight) return null;
  return { iLeft, iRight };
}

/**
 * Inclusive index range of frames overlapping the HALF-OPEN span [t0, t1), or
 * null when the span overlaps no frame (including when it lies entirely past
 * the last one). A zero-length span resolves to the frame containing t0.
 */
export function frameRangeForTimeSpan(
  starts: number[],
  binWidth: number,
  t0: number,
  t1: number,
): { start: number; end: number } | null {
  if (starts.length === 0) return null;
  const start = firstFrameOverlapping(starts, binWidth, t0);
  if (start >= starts.length) return null;
  // Half-open on the right: a frame starting exactly at t1 is outside the span.
  // The tolerance covers f32 round-off — `starts[k] + binWidth` can land a hair
  // past `starts[k+1]`, so a span ending at one frame's end would otherwise
  // pick up its neighbour. Same 1e-3 relative tolerance the Rust-side bin-width
  // inference uses for CSV round-off.
  const end = t1 <= t0 ? start : firstStartAtOrAfter(starts, t1 - binWidth * 1e-3) - 1;
  if (end < start) return null;
  return { start, end };
}

/** Inclusive index range of frames whose START falls in [lo, hi), or null if none. */
function frameStartRangeIn(starts: number[], lo: number, hi: number): { start: number; end: number } | null {
  const start = firstStartAtOrAfter(starts, lo);
  if (start >= starts.length) return null;
  const end = firstStartAtOrAfter(starts, hi) - 1;
  if (end < start) return null;
  return { start, end };
}

/**
 * Inclusive index range of frames whose START falls in bucket `b` of width
 * `bucketWidth` (buckets anchored to absolute time, so they don't re-partition
 * as the viewport scrolls), or null when the bucket holds no frames. This is
 * the partition the grouped polyline averages over, so the hover readout must
 * use the same one.
 */
export function bucketFrameRange(
  starts: number[],
  bucketWidth: number,
  b: number,
): { start: number; end: number } | null {
  if (starts.length === 0 || !(bucketWidth > 0)) return null;
  return frameStartRangeIn(starts, b * bucketWidth, (b + 1) * bucketWidth);
}

// ── Units ───────────────────────────────────────────────────────────────────
// A "unit" is what the buzzdetect panel treats as one indivisible thing: the
// band it washes, the region it highlights on hover, and the span a click
// selects. It's a single frame when the panel resolves frames individually,
// and the whole bucket frames are grouped into otherwise. The three functions
// below are the only place that choice is made — the draw loop enumerates
// units over the viewport, hit-testing looks one up by time, and because both
// go through here they can't disagree about where a unit begins or ends.

/** A unit: the frames it covers (inclusive indices) and its own time extent. */
export interface FrameUnit {
  start: number;
  end: number;
  tStart: number;
  tEnd: number;
}

/**
 * Whether `unitWidth` groups several frames into one unit rather than
 * resolving them individually. The tolerance keeps a unit width pinned at the
 * file's own frame length reading as ungrouped despite float round-off.
 */
export function isGroupedUnitWidth(binWidth: number, unitWidth: number): boolean {
  return unitWidth > binWidth * 1.0001;
}

/**
 * Frame-index range + DISPLAY extent for bucket `b` of a grid anchored to
 * SOURCE (file) time, split into one piece per subset segment it touches.
 *
 * A grouped unit's bucket edges have to sit on the same absolute-time grid
 * the subset's own criteria bucketed on (see buzzdetectSubset.ts's
 * `detectionRanges`), not on the display axis — which is shifted by however
 * much got cut before it, and so tiles a DIFFERENT grid than file time once
 * anything's been spliced out. So the bucket is defined in source time first,
 * then converted to display PER SEGMENT it touches (the map is a pure offset
 * within one segment), which is what keeps a bucket's edges on the real
 * file-time boundary regardless of what's been hidden ahead of it.
 *
 * Identity timeline → source time IS display time, so this is one piece at
 * the plain `[b*bucketWidth, (b+1)*bucketWidth)` bucket, same as before.
 */
export function sourceBucketPieces(
  timeline: Timeline,
  starts: number[],
  binWidth: number,
  bucketWidth: number,
  b: number,
): FrameUnit[] {
  const srcLo = b * bucketWidth;
  const srcHi = srcLo + bucketWidth;
  const out: FrameUnit[] = [];
  for (const s of timeline.spansForSourceRange(srcLo, srcHi)) {
    const lo = Math.max(srcLo, s.srcStart);
    const hi = Math.min(srcHi, s.srcEnd);
    if (hi <= lo) continue;
    const dispLo = s.dispStart + (lo - s.srcStart);
    const dispHi = s.dispStart + (hi - s.srcStart);
    const r = frameStartRangeIn(starts, dispLo, dispHi);
    if (!r) continue;
    out.push({ ...r, tStart: dispLo, tEnd: dispHi });
  }
  return out;
}

/**
 * The unit containing time `t`, or null where it holds no frame — a gap
 * between frames (frame length overridden shorter than the frame spacing), a
 * bucket with no frames in it, or a time outside the data.
 *
 * Under a subset, `t` is a display time but the bucket it belongs to is
 * decided in source time (see `sourceBucketPieces`) — and the segment cut may
 * leave more than one piece of that bucket on screen, so the result is
 * whichever piece actually contains `t`.
 */
export function unitAtTime(
  timeline: Timeline,
  starts: number[],
  binWidth: number,
  unitWidth: number,
  t: number,
): FrameUnit | null {
  if (!isGroupedUnitWidth(binWidth, unitWidth)) {
    const i = binAtTime(starts, binWidth, t);
    return i === null ? null : { start: i, end: i, tStart: starts[i], tEnd: starts[i] + binWidth };
  }
  if (!(unitWidth > 0)) return null;
  const b = Math.floor(timeline.toSource(t) / unitWidth);
  const pieces = sourceBucketPieces(timeline, starts, binWidth, unitWidth, b);
  return pieces.find(p => t >= p.tStart && t < p.tEnd) ?? null;
}

/**
 * Enumerates, in time order, the units covering [t0, t1] — widened by one unit
 * each side so a polyline connects to its off-screen neighbours. Empty units
 * are skipped, so uncovered time is simply never visited.
 *
 * A bin width is a drawing/aggregation choice; a segment is a statement about
 * which audio exists. So under a subset the segment wins: a bin wider than a
 * segment (or one that merely straddles a join) must not wash, highlight or
 * select across the cut, because the time on the far side is a different part
 * of the file. `sourceBucketPieces` is what makes that true AND keeps the
 * bucket grid itself anchored to file time — one function serving both jobs
 * instead of grouping on the display axis and cutting the result afterward.
 */
export function forEachUnitInSpan(
  timeline: Timeline,
  starts: number[],
  binWidth: number,
  unitWidth: number,
  t0: number,
  t1: number,
  fn: (u: FrameUnit) => void,
): void {
  if (starts.length === 0) return;
  if (!isGroupedUnitWidth(binWidth, unitWidth)) {
    const r = visibleBinRange(starts, binWidth, t0, t1);
    if (!r) return;
    for (let i = r.iLeft; i <= r.iRight; i++) {
      fn({ start: i, end: i, tStart: starts[i], tEnd: starts[i] + binWidth });
    }
    return;
  }
  if (!(unitWidth > 0)) return;
  // The source-time extent of every segment touching the display window —
  // buckets are anchored to file time, so the grid has to be walked in that
  // domain, not the (possibly multi-segment) display one.
  const spans = timeline.spansForDisplayRange(t0, t1);
  if (spans.length === 0) return;
  const firstBucket = Math.floor(spans[0].srcStart / unitWidth) - 1;
  const lastBucket = Math.floor(spans[spans.length - 1].srcEnd / unitWidth) + 1;
  for (let b = firstBucket; b <= lastBucket; b++) {
    for (const piece of sourceBucketPieces(timeline, starts, binWidth, unitWidth, b)) {
      fn(piece);
    }
  }
}
