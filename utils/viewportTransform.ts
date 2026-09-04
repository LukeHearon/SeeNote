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
  // Estimated rendered text width in pixels. No longer used for right-justify
  // fallback (labels are now left-aligned with ellipsis truncation), kept for
  // API compatibility.
  textWidth: number;
}

export interface LabelPlacement {
  // Left edge of the label in container pixels.
  leftX: number;
}

export const computeLabelPlacement = (
  input: LabelPlacementInput,
): LabelPlacement => {
  const { annStartX, annEndX, selStartX, selEndX, inset } = input;

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

  return { leftX };
};

// ---------------------------------------------------------------------------
// Annotation hover-button horizontal placement.
//
// The edit (pencil) and delete buttons normally sit a small inset from the
// annotation's right edge. When the annotation's end scrolls off the right of
// the viewport, they pin a small inset from the viewport's right edge instead,
// so they stay reachable while the body extends off-screen — the right-edge
// mirror of the screen-left pin in computeLabelPlacement above.
//
// Returns the screen x (container pixels) of the button's right edge: callers
// convert to a div-relative `right` CSS value via `(annEndX - anchorX)`.
//
// `naturalInset` and `pinnedInset` are distinct because some buttons (e.g. the
// delete badge) sit *past* the annotation's own edge — a negative natural
// inset — which would place the button off-screen if reused as the pinned
// offset from the viewport edge. `pinnedInset` must keep the button's full
// width inside the viewport, so it's always a positive margin from the edge.
export const computeButtonAnchorX = (
  annStartX: number,
  annEndX: number,
  containerWidth: number,
  naturalInset: number,
  pinnedInset: number,
  minMargin: number,
): number => {
  const naturalX = annEndX - naturalInset;
  const pinnedX = containerWidth - pinnedInset;
  return Math.max(annStartX + minMargin, Math.min(naturalX, pinnedX));
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

// Column rate (columns/second) the offscreen spectrogram buffer is built at:
// exactly ONE column per physical pixel.
//
// Matching the buffer grid to the pixel grid makes the final blit a 1:1 copy.
// Any other ratio means the blit resamples with a phase that slides as the
// view scrolls: single-column transients pulse brighter and dimmer as the
// bilinear weights shift under them ("twinkle"), and near-integer ratios beat
// against the pixel grid into moire bands that crawl across the screen during
// playback. Bridging between the active tier's own column rate and this grid
// happens in the DATA domain instead (see sampleChunkColumnInto), anchored to
// absolute column indices so every pixel is a pure function of file time.
//
// This also keeps the buffer proportional to the window rather than the file:
// built at a tier's own colsPerSec, a 50h file zoomed out wanted a ~180,000-
// column canvas — past the browser's max canvas dimension.
export const resolveRenderCps = (
  pixelsPerSecond: number,
  devicePixelRatio: number,
): number => pixelsPerSecond * devicePixelRatio;

// ---------------------------------------------------------------------------
// Zoom-prop reconciliation.
//
// The spectrogram owns the live zoom in refs (a wheel/pinch step has to reach
// the canvas in the same frame) but the parent owns the `zoomSec` prop, so
// every local zoom is published and comes back one or more commits later.
// React is free to commit those late — and does, while spectrogram tiers are
// decoding and the main thread is busy. A gesture that publishes Z1..Z8 across
// a few frames can have the commit carrying Z4 land after the refs already hold
// Z8; writing it into the refs pairs an old pixelsPerSecond with the scroll
// offset computed at the new one, and the next event's anchor time —
// (scroll + mouseX) / pps — resolves to a completely different part of the
// file. In a 40h file that reads as the zoom landing hours away from the
// pointer.
//
// So: a prop value equal to the last zoom WE published is an echo, and the refs
// (already at or ahead of it) keep what they have — only the width is folded
// in. Anything else is a genuine external zoom (toolbar, fit-to-track, track
// switch, project load) and is accepted.
export interface ZoomRefs {
  zoomSec: number;
  pixelsPerSecond: number;
}

export const reconcileZoomProp = (
  propZoomSec: number,
  containerWidth: number,
  live: ZoomRefs,
  lastPublishedZoomSec: number | null,
): ZoomRefs => {
  if (propZoomSec === lastPublishedZoomSec) {
    return containerWidth > 0 && live.zoomSec > 0
      ? { zoomSec: live.zoomSec, pixelsPerSecond: containerWidth / live.zoomSec }
      : live;
  }
  return {
    zoomSec: propZoomSec,
    pixelsPerSecond: containerWidth > 0 && propZoomSec > 0
      ? containerWidth / propZoomSec
      : live.pixelsPerSecond,
  };
};

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
