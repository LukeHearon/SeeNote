// Shared time↔pixel transform for the time axis.
//
// The spectrogram, ruler, annotation overlays, playhead, and BuzzdetectPanel
// must all map between time (seconds) and horizontal pixels using the exact
// same arithmetic — any divergence breaks the time-axis-synchrony invariant
// (see CLAUDE.md). Both views already share `scrollLeft` and `pixelsPerSecond`
// via the viewport store; these helpers ensure they also share the conversion.

// Time (seconds) → x pixel within the visible canvas.
export const timeToX = (
  timeSec: number,
  scrollLeft: number,
  pixelsPerSecond: number,
): number => timeSec * pixelsPerSecond - scrollLeft;

// x pixel within the visible canvas → time (seconds).
export const xToTime = (
  x: number,
  scrollLeft: number,
  pixelsPerSecond: number,
): number => (scrollLeft + x) / pixelsPerSecond;
