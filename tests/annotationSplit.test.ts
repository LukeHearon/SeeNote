import { describe, it, expect } from 'vitest';
import { splitAnnotation, MIN_SPLIT_PIECE_SEC } from '../utils/annotationSplit';
import type { Annotation } from '../types';

const a = (id: string, start: number, end: number, extra: Partial<Annotation> = {}): Annotation =>
  ({ id, start, end, text: 'bee', color: '#fff', ...extra });

describe('splitAnnotation', () => {
  it('splits into two adjacent pieces, the left keeping the id', () => {
    const list = [a('x', 0, 1), a('y', 2, 6, { raw: '2\t6\tbee' }), a('z', 7, 8)];
    const r = splitAnnotation(list, 'y', 3.5, () => 'new')!;
    expect(r.left).toEqual(a('y', 2, 3.5));
    expect(r.right).toEqual(a('new', 3.5, 6));
    expect(r.annotations.map(x => x.id)).toEqual(['x', 'y', 'new', 'z']);
    // raw is dropped from both pieces so the file rewrites them.
    expect('raw' in r.left || 'raw' in r.right).toBe(false);
    expect(list[1].end).toBe(6); // input untouched
  });

  it('refuses a cut outside or too near an edge', () => {
    const list = [a('y', 2, 6)];
    expect(splitAnnotation(list, 'y', 1)).toBeNull();
    expect(splitAnnotation(list, 'y', 6)).toBeNull();
    expect(splitAnnotation(list, 'y', 2 + MIN_SPLIT_PIECE_SEC / 2)).toBeNull();
    expect(splitAnnotation(list, 'missing', 3)).toBeNull();
  });
});
