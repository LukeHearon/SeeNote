import { describe, it, expect } from 'vitest';
import { nextFileFilter, passesFileFilter } from '../utils/fileFilter';
import { dirCountsFromFiles, totalCounts } from '../utils/fileTreeCounts';

describe('file filter', () => {
  it('cycles neutral → has → lacks → neutral', () => {
    expect(nextFileFilter('all')).toBe('annotated');
    expect(nextFileFilter('annotated')).toBe('unannotated');
    expect(nextFileFilter('unannotated')).toBe('all');
  });
  it('keeps tracks according to the mode', () => {
    expect(passesFileFilter(true, 'all')).toBe(true);
    expect(passesFileFilter(false, 'all')).toBe(true);
    expect(passesFileFilter(true, 'annotated')).toBe(true);
    expect(passesFileFilter(false, 'annotated')).toBe(false);
    expect(passesFileFilter(true, 'unannotated')).toBe(false);
    expect(passesFileFilter(false, 'unannotated')).toBe(true);
  });
});

describe('dirCountsFromFiles', () => {
  const files = ['/r/a/x.mp3', '/r/a/b/y.mp3', '/r/a/b/z.mp3', '/r/c/w.mp3', '/other/q.mp3'];
  const counts = dirCountsFromFiles('/r', files, new Set(['/r/a/x.mp3', '/r/a/b/y.mp3']), new Set(['/r/a/b/y.mp3', '/r/c/w.mp3']));

  it('counts every ancestor folder', () => {
    expect(counts.get('/r/a')).toEqual({ total: 3, annotated: 2, buzzdetect: 1 });
    expect(counts.get('/r/a/b')).toEqual({ total: 2, annotated: 1, buzzdetect: 1 });
    expect(counts.get('/r/c')).toEqual({ total: 1, annotated: 0, buzzdetect: 1 });
  });
  it('ignores tracks outside the root and files directly in it', () => {
    expect(counts.has('/other')).toBe(false);
    expect(counts.size).toBe(3);
  });
});

describe('totalCounts', () => {
  it('counts across the list', () => {
    expect(totalCounts(['/a', '/b', '/c'], new Set(['/a']), new Set(['/a', '/c']))).toEqual({ total: 3, annotated: 1, buzzdetect: 2 });
  });
});
