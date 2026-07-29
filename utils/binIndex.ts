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
  const bStart = b * bucketWidth;
  const start = firstStartAtOrAfter(starts, bStart);
  if (start >= starts.length) return null;
  const end = firstStartAtOrAfter(starts, bStart + bucketWidth) - 1;
  if (end < start) return null;
  return { start, end };
}
