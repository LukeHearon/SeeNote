import { describe, it, expect } from 'vitest';
import { extendGestureFor, selectionsEqual, spanBetween } from '../utils/selectionExtend';

describe('spanBetween', () => {
  it('orders the two ends, remembering which was pinned', () => {
    expect(spanBetween(5, 7)).toEqual({ start: 5, end: 7, anchor: 5 });
    expect(spanBetween(7, 5)).toEqual({ start: 5, end: 7, anchor: 7 });
  });

  it('is nothing once the edge is back on the anchor', () => {
    expect(spanBetween(5, 5)).toBeNull();
  });
});

describe('selectionsEqual', () => {
  it('treats null as its own value', () => {
    expect(selectionsEqual(null, null)).toBe(true);
    expect(selectionsEqual(null, { start: 1, end: 2 })).toBe(false);
  });

  it('compares within a sub-millisecond tolerance', () => {
    expect(selectionsEqual({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(selectionsEqual({ start: 1, end: 2 }, { start: 1, end: 2.5 })).toBe(false);
  });
});

describe('extendGestureFor', () => {
  it('starts at the playhead when nothing is selected, and drags it along', () => {
    expect(extendGestureFor(null, null, 5)).toEqual({ anchor: 5, edge: 5, follow: true, selection: null });
  });

  it('adjusts an existing selection from its end, leaving the playhead alone', () => {
    // Playhead at 3 (where a drag left it) must not become an end of the span.
    expect(extendGestureFor(null, { start: 4, end: 9 }, 3)).toEqual({
      anchor: 4, edge: 9, follow: false, selection: { start: 4, end: 9 },
    });
  });

  it('adjusts the end placed last when the span was drawn backwards', () => {
    // Dragged from 10s back to 3s: 10 is pinned, so the arrows move the start.
    const backwards = { start: 3, end: 10, anchor: 10 };
    expect(extendGestureFor(null, backwards, 10)).toEqual({
      anchor: 10, edge: 3, follow: false, selection: backwards,
    });
    const forwards = { start: 3, end: 10, anchor: 3 };
    expect(extendGestureFor(null, forwards, 3)).toEqual({
      anchor: 3, edge: 10, follow: false, selection: forwards,
    });
  });

  it('continues a gesture that still describes the live selection', () => {
    const gesture = { anchor: 5, edge: 6, follow: true, selection: { start: 5, end: 6 } };
    expect(extendGestureFor(gesture, { start: 5, end: 6 }, 6)).toBe(gesture);
    // Collapsed to nothing mid-run: still the same gesture, so the next step
    // opens the span on the other side of the anchor.
    const collapsed = { anchor: 5, edge: 5, follow: true, selection: null };
    expect(extendGestureFor(collapsed, null, 5)).toBe(collapsed);
  });

  it('restarts when something else has changed the selection', () => {
    const gesture = { anchor: 5, edge: 6, follow: true, selection: { start: 5, end: 6 } };
    const dragged = { start: 20, end: 30 };
    expect(extendGestureFor(gesture, dragged, 20)).toEqual({
      anchor: 20, edge: 30, follow: false, selection: dragged,
    });
  });
});
