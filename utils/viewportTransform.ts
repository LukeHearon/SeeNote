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

// Maximum horizontal scroll (in pixels). Mirrors Spectrogram's `computeMaxScroll`:
// allows a 40%-of-viewport overrun past the end of the file so the last events
// aren't pinned to the right edge. Shared as the single source of truth for the
// scroll clamp so the recenter action never disagrees with pan/zoom.
export const maxScroll = (
  durationSec: number,
  pixelsPerSecond: number,
  containerWidth: number,
): number =>
  Math.max(0, durationSec * pixelsPerSecond - containerWidth + containerWidth * 0.4);

// Scroll offset (in pixels) that centers `timeSec` in the visible window,
// clamped so the view never scrolls before the start or past the end overrun.
// Used by the recenter-playhead action; keeps zoom (pixelsPerSecond) unchanged.
// When the whole file fits in the viewport the clamp pins scroll to 0.
export const centerScrollLeft = (
  timeSec: number,
  pixelsPerSecond: number,
  containerWidth: number,
  durationSec: number,
): number => {
  const ideal = timeSec * pixelsPerSecond - containerWidth / 2;
  const max = maxScroll(durationSec, pixelsPerSecond, containerWidth);
  return Math.max(0, Math.min(ideal, max));
};
