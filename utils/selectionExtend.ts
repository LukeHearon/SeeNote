import { Selection } from '../types';

/** Times closer than this are the same instant, as far as a selection cares. */
const EPS = 1e-4;

/**
 * A keyboard extend is a gesture, not a series of independent presses: one end
 * (the `anchor`) is pinned where the run started, and the arrows walk the other
 * (the `edge`). Held in a ref by useArrowKeys and re-derived from the current
 * selection whenever something else has changed it underneath.
 *
 * `follow` is whether the playhead travels with the edge. It does for a
 * selection being drawn out of nothing — that's the playhead being dragged with
 * Shift held — but not for one that already existed, where the arrows are
 * trimming an existing span and the playhead is a separate thing the user
 * placed.
 */
export interface ExtendGesture {
  anchor: number;
  edge: number;
  follow: boolean;
  /** What this gesture last produced, so an outside change can be spotted. */
  selection: Selection | null;
}

export function selectionsEqual(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.start - b.start) < EPS && Math.abs(a.end - b.end) < EPS;
}

/**
 * The selection between a gesture's two ends, remembering which end was pinned.
 * Null when the edge has come back to the anchor — the next press then opens a
 * fresh span on the other side, which is what makes running left past the start
 * turn into a backwards-looking selection.
 */
export function spanBetween(anchor: number, edge: number): Selection | null {
  if (Math.abs(edge - anchor) < EPS) return null;
  return { start: Math.min(anchor, edge), end: Math.max(anchor, edge), anchor };
}

/**
 * The gesture a keyboard extend should continue, given what's selected now.
 *
 * `previous` continues only while it still describes the live selection —
 * anything else (a drag, a click, Esc) has taken over since, so a new gesture
 * starts. A selection that already exists is adjusted from the end that was
 * placed last (its `anchor` names the other one), falling back to its end when
 * it was made with no direction; with nothing selected, both ends start at the
 * playhead.
 */
export function extendGestureFor(
  previous: ExtendGesture | null,
  selection: Selection | null,
  playhead: number,
): ExtendGesture {
  if (previous && selectionsEqual(previous.selection, selection)) return previous;
  if (selection) {
    // Pick up where the selection was left: whichever end was placed last is
    // the one that goes on moving, whether it was drawn backwards with the
    // mouse, walked there with the arrows, or thrown to the track's start.
    const heldAtEnd = selection.anchor !== undefined && Math.abs(selection.anchor - selection.end) < EPS;
    return heldAtEnd
      ? { anchor: selection.end, edge: selection.start, follow: false, selection }
      : { anchor: selection.start, edge: selection.end, follow: false, selection };
  }
  return { anchor: playhead, edge: playhead, follow: true, selection: null };
}
