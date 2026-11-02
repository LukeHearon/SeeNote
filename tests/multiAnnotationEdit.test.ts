import { describe, it, expect } from 'vitest';
import type { Annotation } from '../types';
import {
  toggleId, commonDuration, deltaRange, clampSharedDelta, shiftAnnotations, withDuration, MIN_ANNOTATION_SEC,
} from '../utils/multiAnnotationEdit';

const ann = (id: string, start: number, end: number): Annotation =>
  ({ id, start, end, text: id, color: '#fff' } as Annotation);

describe('toggleId', () => {
  it('adds a missing id and removes a present one', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('commonDuration', () => {
  const list = [ann('a', 0, 2), ann('b', 5, 7), ann('c', 9, 10)];
  it('returns the shared duration', () => {
    expect(commonDuration(list, ['a', 'b'])).toBe(2);
  });
  it('is null when any member differs', () => {
    expect(commonDuration(list, ['a', 'b', 'c'])).toBeNull();
  });
  it('tolerates float noise only', () => {
    expect(commonDuration([ann('a', 0.1, 0.4), ann('b', 1, 1.3)], ['a', 'b'])).not.toBeNull();
    expect(commonDuration([ann('a', 0, 2.001), ann('b', 1, 3)], ['a', 'b'])).toBeNull();
  });
  it('is null for no members', () => {
    expect(commonDuration(list, [])).toBeNull();
  });
});

describe('shared delta', () => {
  const span = { lo: 0, hi: 20 };
  const list = [ann('a', 1, 3), ann('b', 10, 19)];
  const ids = new Set(['a', 'b']);

  it('a move stops when the first member reaches the span edge', () => {
    const ranges = list.map(a => deltaRange(a, 'both', span));
    expect(clampSharedDelta(5, ranges)).toBe(1); // b may only go 1s right
    expect(clampSharedDelta(-5, ranges)).toBe(-1); // a may only go 1s left
    const moved = shiftAnnotations(list, ids, 'both', 1);
    expect(moved.map(a => [a.start, a.end])).toEqual([[2, 4], [11, 20]]);
  });

  it('an end resize keeps every member above the minimum length', () => {
    const ranges = list.map(a => deltaRange(a, 'end', span));
    expect(clampSharedDelta(-100, ranges)).toBeCloseTo(MIN_ANNOTATION_SEC - 2); // a: dur 2 → 0.05
  });

  it('a start resize moves only starts', () => {
    const moved = shiftAnnotations(list, ids, 'start', 0.5);
    expect(moved.map(a => [a.start, a.end])).toEqual([[1.5, 3], [10.5, 19]]);
  });

  it('leaves non-members alone', () => {
    const moved = shiftAnnotations([...list, ann('c', 4, 5)], ids, 'both', 1);
    expect(moved[2]).toEqual(ann('c', 4, 5));
  });

  it('a single member behaves as a lone annotation', () => {
    expect(clampSharedDelta(100, [deltaRange(ann('x', 5, 6), 'both', span)])).toBe(14);
  });
});

describe('withDuration', () => {
  it('anchors on the start and caps at the limit', () => {
    const out = withDuration([ann('a', 1, 2), ann('b', 9, 9.5), ann('c', 0, 1)], new Set(['a', 'b']), 3, () => 10);
    expect(out.map(a => [a.start, a.end])).toEqual([[1, 4], [9, 10], [0, 1]]);
  });
  it('keeps an annotation that cannot grow at all', () => {
    const out = withDuration([ann('a', 10, 11)], new Set(['a']), 3, () => 10);
    expect(out[0]).toEqual(ann('a', 10, 11));
  });
});
