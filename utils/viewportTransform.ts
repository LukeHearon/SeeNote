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

// ---------------------------------------------------------------------------
// Annotation label horizontal placement.
//
// An annotation's name label normally sits a small inset from the annotation's
// left edge. Two effects shift it rightward so it stays useful:
//
//   1. Screen-left pinning: when the annotation's start scrolls off the left of
//      the viewport, the label is pinned a small inset from the viewport's left
//      edge so the name stays readable while the body extends off-screen.
//
//   2. Selection "pop": when an active selection overlaps the annotation, the
//      label pops rightward to the selection's start so the user can read the
//      name right where they're looking. If there isn't horizontal room for the
//      text before the annotation's right edge, the label right-justifies
//      against that edge instead.
//
// These compose by precedence: the label's left edge is the rightmost (max) of
// the natural inset, the screen-left pin, and the selection-start position —
// then, if the text wouldn't fit before the annotation's right edge, it
// right-justifies against that edge instead.
//
// All inputs/outputs are in container pixels (x relative to the viewport's left
// edge, as produced by timeToX), so the result can be applied to an absolutely
// positioned element that shares that origin.

export interface LabelPlacementInput {
  // Annotation bounds in container pixels.
  annStartX: number;
  annEndX: number;
  // Selection bounds in container pixels, or null if no active selection.
  selStartX: number | null;
  selEndX: number | null;
  // Inset from an edge, in pixels.
  inset: number;
  // Estimated rendered text width in pixels (0 if unknown — then no
  // right-justify fallback is applied).
  textWidth: number;
}

export interface LabelPlacement {
  // Left edge of the label in container pixels.
  leftX: number;
  // Whether the label is right-justified against the annotation's right edge
  // (i.e. there wasn't room for the text before that edge).
  rightJustified: boolean;
}

export const computeLabelPlacement = (
  input: LabelPlacementInput,
): LabelPlacement => {
  const { annStartX, annEndX, selStartX, selEndX, inset, textWidth } = input;

  // Natural position and screen-left pin: rightmost of "inset past annotation
  // start" and "inset past viewport left".
  let leftX = Math.max(annStartX + inset, inset);

  // Selection pop: only when the selection actually overlaps the annotation.
  const selectionOverlaps =
    selStartX !== null &&
    selEndX !== null &&
    selEndX > annStartX &&
    selStartX < annEndX;
  if (selectionOverlaps) {
    leftX = Math.max(leftX, (selStartX as number) + 6);
  }

  // Right-justify fallback: if the text wouldn't fit between leftX and the
  // annotation's right edge, pin the text's right edge to that edge instead.
  // Only meaningful when we have a text width to reason about.
  const rightLimit = annEndX - inset;
  if (textWidth > 0 && leftX + textWidth > rightLimit) {
    return { leftX: rightLimit - textWidth, rightJustified: true };
  }

  return { leftX, rightJustified: false };
};

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
