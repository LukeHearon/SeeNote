import { describe, it, expect } from 'vitest';
import { coalesceColumnRuns } from '../utils/columnRuns';

describe('coalesceColumnRuns', () => {
  it('returns nothing for a zero or negative width', () => {
    expect(coalesceColumnRuns(0, () => true)).toEqual([]);
    expect(coalesceColumnRuns(-5, () => true)).toEqual([]);
  });

  it('returns nothing when no column fills', () => {
    expect(coalesceColumnRuns(10, () => false)).toEqual([]);
  });

  it('merges an all-filled span into a single rect', () => {
    expect(coalesceColumnRuns(10, () => true)).toEqual([{ x: 0, w: 10 }]);
  });

  it('splits on gaps', () => {
    // Columns 0,1 filled; 2,3 empty; 4 filled.
    expect(coalesceColumnRuns(5, c => c !== 2 && c !== 3)).toEqual([
      { x: 0, w: 2 },
      { x: 4, w: 1 },
    ]);
  });

  it('closes a run that reaches the right edge', () => {
    expect(coalesceColumnRuns(4, c => c >= 2)).toEqual([{ x: 2, w: 2 }]);
  });

  it('clamps the trailing run to a fractional width', () => {
    expect(coalesceColumnRuns(3.5, () => true)).toEqual([{ x: 0, w: 3.5 }]);
  });

  it('calls the predicate once per column, in order', () => {
    const seen: number[] = [];
    coalesceColumnRuns(4, c => { seen.push(c); return false; });
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('covers exactly the columns the predicate selected', () => {
    const filled = (c: number) => c % 3 === 0;
    const runs = coalesceColumnRuns(12, filled);
    const covered = new Set<number>();
    for (const r of runs) for (let c = r.x; c < r.x + r.w; c++) covered.add(c);
    for (let c = 0; c < 12; c++) expect(covered.has(c)).toBe(filled(c));
  });
});
