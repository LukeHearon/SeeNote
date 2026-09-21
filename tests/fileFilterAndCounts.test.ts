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

import { columnLayout, HEADER_BUTTON_PX, MIN_NAME_PX } from '../utils/fileTreeColumns';

describe('columnLayout', () => {
  it('shows nothing when the panel is too narrow to leave room for names', () => {
    const c = columnLayout(MIN_NAME_PX, 100, true);
    expect([c.annotation, c.buzzdetect, c.total]).toEqual([false, false, false]);
  });
  it('drops columns from the right as the panel narrows', () => {
    const w = columnLayout(1000, 224_060, true).widthPx;
    expect(columnLayout(MIN_NAME_PX + 3 * w, 224_060, true)).toMatchObject({ annotation: true, buzzdetect: true, total: true });
    expect(columnLayout(MIN_NAME_PX + 3 * w - 1, 224_060, true)).toMatchObject({ annotation: true, buzzdetect: true, total: false });
    expect(columnLayout(MIN_NAME_PX + 2 * w - 1, 224_060, true)).toMatchObject({ annotation: true, buzzdetect: false, total: false });
    expect(columnLayout(MIN_NAME_PX + w - 1, 224_060, true).annotation).toBe(false);
  });
  it('has no buzzdetect column without a buzzdetect directory, and total takes its place', () => {
    const w = columnLayout(1000, 50, false).widthPx;
    expect(columnLayout(MIN_NAME_PX + 2 * w, 50, false)).toMatchObject({ annotation: true, buzzdetect: false, total: true });
  });
  it('never shortens a name: a long name pushes the columns out', () => {
    const w = columnLayout(1000, 50, true).widthPx;
    // The longest name reaches 400px, so an annotation column needs 400 + gap + w.
    expect(columnLayout(400 + 8 + w, 50, true).annotation).toBe(true);
    expect(columnLayout(400 + 8 + w - 1, 50, true, 400).annotation).toBe(false);
    expect(columnLayout(400 + 8 + w, 50, true, 400).annotation).toBe(true);
  });
  it('never makes a column narrower than a header button', () => {
    expect(columnLayout(1000, 1, true).widthPx).toBeGreaterThanOrEqual(HEADER_BUTTON_PX);
  });
});
