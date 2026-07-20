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
  if (iRight < 0) return null;
  // First frame whose extent ends after t0 — i.e. skip frames entirely left of
  // the window — then one extra to connect.
  let iLeft = lastStartAtOrBefore(starts, t0);
  if (iLeft < 0) iLeft = 0;
  else if (starts[iLeft] + binWidth <= t0) iLeft = Math.min(iLeft + 1, starts.length - 1);
  iLeft = Math.max(0, iLeft - 1);
  if (iLeft > iRight) return null;
  return { iLeft, iRight };
}
