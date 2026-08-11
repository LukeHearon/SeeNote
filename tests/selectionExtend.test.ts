import { describe, it, expect } from 'vitest';
import { extendSelection, selectionAnchor } from '../utils/selectionExtend';

describe('selectionAnchor', () => {
  it('is the playhead when nothing is selected', () => {
    expect(selectionAnchor(null, 5)).toBe(5);
  });

  it('is the far edge of an existing selection', () => {
    // Playhead at the end (grown rightwards) -> anchored at the start.
    expect(selectionAnchor({ start: 3, end: 7 }, 7)).toBe(3);
    // Playhead at the start (grown leftwards) -> anchored at the end.
    expect(selectionAnchor({ start: 3, end: 7 }, 3)).toBe(7);
    // Playhead pulled back inside -> still the further edge.
    expect(selectionAnchor({ start: 3, end: 7 }, 6.5)).toBe(3);
  });
});

describe('extendSelection', () => {
  it('creates a selection from the playhead on the first step', () => {
    expect(extendSelection(null, 5, 6)).toEqual({ start: 5, end: 6 });
    expect(extendSelection(null, 5, 4)).toEqual({ start: 4, end: 5 });
  });

  it('grows away from the anchor and shrinks back towards it', () => {
    const grown = extendSelection({ start: 5, end: 6 }, 6, 7);
    expect(grown).toEqual({ start: 5, end: 7 });
    expect(extendSelection(grown, 7, 6)).toEqual({ start: 5, end: 6 });
  });

  it('collapses to nothing when the playhead returns to the anchor', () => {
    expect(extendSelection({ start: 5, end: 6 }, 6, 5)).toBeNull();
  });

  it('flips to the far side once past the anchor', () => {
    // Collapsed at the anchor (5), the next leftward step selects behind it.
    expect(extendSelection(null, 5, 4)).toEqual({ start: 4, end: 5 });
  });

  it('handles a run to the track edges', () => {
    expect(extendSelection({ start: 5, end: 6 }, 6, 0)).toEqual({ start: 0, end: 5 });
    expect(extendSelection({ start: 5, end: 6 }, 6, 100)).toEqual({ start: 5, end: 100 });
  });
});
