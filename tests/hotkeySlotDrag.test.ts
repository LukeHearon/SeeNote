import { describe, it, expect } from 'vitest';
import { applySlotDrop, insertDirections, resolveSlotDropTarget, RowSpan } from '../utils/hotkeySlotDrag';
import type { AnnotationTool } from '../types';

// Tool 0 is Custom; the rest are keyed by the `keys` string ('-' = unassigned).
// e.g. tools('A1 B2 C- D4') → A on 1, B on 2, C unassigned, D on 4.
const tools = (spec: string): AnnotationTool[] => [
  { id: 'custom', key: '0', text: '', color: '#000' },
  ...spec.split(' ').map(s => ({ id: s[0], text: s[0], color: '#000', key: s[1] === '-' ? null : s[1] })),
];
const idx = (ts: AnnotationTool[], text: string) => ts.findIndex(t => t.text === text);
const keys = (ts: AnnotationTool[]) =>
  Object.fromEntries(ts.slice(1).map(t => [t.text, t.key]));

// Nine 32px rows with 8px gaps, starting at y=0: row i spans [40i, 40i+32].
const rows: RowSpan[] = Array.from({ length: 9 }, (_, i) => ({ top: i * 40, bottom: i * 40 + 32 }));

describe('applySlotDrop', () => {
  it('places onto an empty slot and swaps with an occupant', () => {
    const ts = tools('A1 B2 C-');
    expect(keys(applySlotDrop(ts, idx(ts, 'C'), { type: 'slot', key: '5' }))).toEqual({ A: '1', B: '2', C: '5' });
    expect(keys(applySlotDrop(ts, idx(ts, 'A'), { type: 'slot', key: '2' }))).toEqual({ A: '2', B: '1', C: null });
    expect(keys(applySlotDrop(ts, idx(ts, 'C'), { type: 'slot', key: '1' }))).toEqual({ A: null, B: '2', C: '1' });
  });

  it('inserts between, bumping upward into the nearest free slot', () => {
    // Slot 1 free; insert X between 3 and 4 bumping up: B,C move 2→1, 3→2.
    const ts = tools('B2 C3 D4 X-');
    expect(keys(applySlotDrop(ts, idx(ts, 'X'), { type: 'insert', gap: 2, direction: 'up' })))
      .toEqual({ B: '1', C: '2', D: '4', X: '3' });
  });

  it('inserts between, bumping downward into the nearest free slot', () => {
    const ts = tools('A1 B2 C3 X-');
    expect(keys(applySlotDrop(ts, idx(ts, 'X'), { type: 'insert', gap: 0, direction: 'down' })))
      .toEqual({ A: '1', X: '2', B: '3', C: '4' });
  });

  it("treats the dragged tool's own slot as free", () => {
    // Move A (slot 1) between C (3) and D (4): B,C bump up into 1,2.
    const ts = tools('A1 B2 C3 D4 E5 F6 G7 H8 I9');
    expect(keys(applySlotDrop(ts, idx(ts, 'A'), { type: 'insert', gap: 2, direction: 'up' })))
      .toEqual({ A: '3', B: '1', C: '2', D: '4', E: '5', F: '6', G: '7', H: '8', I: '9' });
  });

  it('inserts at the very top or bottom, bumping everything inward', () => {
    const ts = tools('A1 B2 C3 X-');
    expect(keys(applySlotDrop(ts, idx(ts, 'X'), { type: 'insert', gap: -1, direction: 'down' })))
      .toEqual({ X: '1', A: '2', B: '3', C: '4' });
    const low = tools('H8 I9 X-');
    expect(keys(applySlotDrop(low, idx(low, 'X'), { type: 'insert', gap: 8, direction: 'up' })))
      .toEqual({ H: '7', I: '8', X: '9' });
  });

  it('is a no-op when there is no free slot in the given direction', () => {
    const ts = tools('A1 B2 C3 X-');
    expect(applySlotDrop(ts, idx(ts, 'X'), { type: 'insert', gap: 0, direction: 'up' })).toBe(ts);
  });

  it('unassigns', () => {
    const ts = tools('A1');
    expect(keys(applySlotDrop(ts, idx(ts, 'A'), { type: 'unassigned' }))).toEqual({ A: null });
  });
});

describe('insertDirections', () => {
  it('reports free space on each side of a gap', () => {
    const ts = tools('A1 B2 C3 X-');
    expect(insertDirections(ts, idx(ts, 'X'), 0)).toEqual({ up: false, down: true });
    const full = tools('A1 B2 C3 D4 E5 F6 G7 H8 I9 X-');
    expect(insertDirections(full, idx(full, 'X'), 4)).toEqual({ up: false, down: false });
  });
});

describe('resolveSlotDropTarget', () => {
  const ts = tools('B2 C3 D4 X-'); // slot 1 free above, 5–9 free below
  const x = idx(ts, 'X');

  it('targets the slot when over a row centre or an empty slot', () => {
    expect(resolveSlotDropTarget(ts, x, rows, 56)).toEqual({ type: 'slot', key: '2' });
    expect(resolveSlotDropTarget(ts, x, rows, 16)).toEqual({ type: 'slot', key: '1' });
    // Bottom edge of slot 1 borders an empty slot → no insert, just the slot.
    expect(resolveSlotDropTarget(ts, x, rows, 30)).toEqual({ type: 'slot', key: '1' });
  });

  it('picks the bump direction by which side of the gap midpoint the pointer is', () => {
    // Gap between slot 3 (80–112) and 4 (120–152); midpoint 116.
    expect(resolveSlotDropTarget(ts, x, rows, 108)).toEqual({ type: 'insert', gap: 2, direction: 'up' });
    expect(resolveSlotDropTarget(ts, x, rows, 114)).toEqual({ type: 'insert', gap: 2, direction: 'up' });
    expect(resolveSlotDropTarget(ts, x, rows, 118)).toEqual({ type: 'insert', gap: 2, direction: 'down' });
    expect(resolveSlotDropTarget(ts, x, rows, 124)).toEqual({ type: 'insert', gap: 2, direction: 'down' });
  });

  it('uses the only available direction across the whole gap', () => {
    const down = tools('A1 B2 C3 X-');
    expect(resolveSlotDropTarget(down, idx(down, 'X'), rows, 30)).toEqual({ type: 'insert', gap: 0, direction: 'down' });
    expect(resolveSlotDropTarget(down, idx(down, 'X'), rows, 42)).toEqual({ type: 'insert', gap: 0, direction: 'down' });
  });

  it('treats the space above slot 1 and below slot 9 as insert-and-bump gaps', () => {
    const ts = tools('A1 B2 C3 X-');
    expect(resolveSlotDropTarget(ts, idx(ts, 'X'), rows, -3)).toEqual({ type: 'insert', gap: -1, direction: 'down' });
    expect(resolveSlotDropTarget(ts, idx(ts, 'X'), rows, 2)).toEqual({ type: 'insert', gap: -1, direction: 'down' });
    // Slot 9 empty → just place there, no bump.
    expect(resolveSlotDropTarget(ts, idx(ts, 'X'), rows, 360)).toEqual({ type: 'slot', key: '9' });
    const low = tools('H8 I9 X-');
    expect(resolveSlotDropTarget(low, idx(low, 'X'), rows, 360)).toEqual({ type: 'insert', gap: 8, direction: 'up' });
    expect(resolveSlotDropTarget(low, idx(low, 'X'), rows, 350)).toEqual({ type: 'insert', gap: 8, direction: 'up' });
  });

  it("still sees the dragged tool in its own slot when judging a gap's neighbours", () => {
    // Pick up A from 1,2,3 and drop between 1 and 2 (or above 1): B and C bump
    // down, A lands on 2. Bumping up would only put A back, so isn't offered.
    const ts = tools('A1 B2 C3');
    const src = idx(ts, 'A');
    for (const y of [30, 34, 38, 42]) {
      expect(resolveSlotDropTarget(ts, src, rows, y)).toEqual({ type: 'insert', gap: 0, direction: 'down' });
    }
    expect(keys(applySlotDrop(ts, src, { type: 'insert', gap: 0, direction: 'down' })))
      .toEqual({ A: '2', B: '3', C: '4' });
    // Strip above slot 1: inserting there only puts A back — plain slot drop.
    expect(resolveSlotDropTarget(ts, src, rows, -3)).toEqual({ type: 'slot', key: '1' });
  });

  it('falls back to swap when every slot is full', () => {
    const full = tools('A1 B2 C3 D4 E5 F6 G7 H8 I9 X-');
    expect(resolveSlotDropTarget(full, idx(full, 'X'), rows, 30)).toEqual({ type: 'slot', key: '1' });
    expect(resolveSlotDropTarget(full, idx(full, 'X'), rows, 37)).toEqual({ type: 'slot', key: '2' });
  });
});
