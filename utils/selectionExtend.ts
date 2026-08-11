import { Selection } from '../types';
import { clamp } from './helpers';

/** Times closer than this are the same instant, as far as a selection cares. */
const EPS = 1e-4;

/**
 * How far one arrow-key scrub moves the playhead: 10% of the visible window.
 * Shared by the plain arrow scrub (usePlaybackTransport) and the Shift+arrow
 * selection extend (useSelectionKeyboard) so the two stay in step.
 */
export function scrubStep(zoomSec: number): number {
  return zoomSec * 0.1;
}

export function scrubTarget(current: number, duration: number, zoomSec: number, direction: -1 | 1): number {
  return clamp(current + direction * scrubStep(zoomSec), 0, duration);
}

/**
 * The fixed end of a keyboard-extended selection — the point the playhead is
 * moving away from (or back towards).
 *
 * Derived rather than remembered: the playhead always sits on one edge of a
 * selection it has been extending, so the *other* edge is the anchor. Picking
 * the edge further from the playhead means a selection whose playhead has been
 * dragged back inside it still shrinks from the right side. With no selection,
 * the playhead itself is the anchor — that's a fresh extend starting here.
 */
export function selectionAnchor(selection: Selection | null, playhead: number): number {
  if (!selection) return playhead;
  return Math.abs(selection.start - playhead) >= Math.abs(selection.end - playhead)
    ? selection.start
    : selection.end;
}

/**
 * The selection after the playhead moves from `playhead` to `target` with Shift
 * held. Null when the move collapses the selection onto its anchor — the next
 * press then starts a fresh one on the far side, which is what makes running
 * left past the start turn into a backwards-looking selection.
 */
export function extendSelection(
  selection: Selection | null,
  playhead: number,
  target: number,
): Selection | null {
  const anchor = selectionAnchor(selection, playhead);
  if (Math.abs(target - anchor) < EPS) return null;
  return { start: Math.min(anchor, target), end: Math.max(anchor, target) };
}
