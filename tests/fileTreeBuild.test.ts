import { describe, it, expect } from 'vitest';
import { buildTree, filterUnderDir, flattenTree, getAllDirPaths, getAncestorPaths, toggleDirInSet } from '../utils/fileTreeBuild';

const files = ['/r/a/x.mp3', '/r/a/b/y.mp3', '/r/c/w.mp3', '/r/top.mp3'];
const build = (nonMedia: string[] = []) => buildTree('/r', files, nonMedia, new Set(['/r/a/x.mp3']), new Set(), files);

describe('buildTree', () => {
  it('nests folders and keeps counts from the unfiltered list', () => {
    const tree = build();
    expect(tree.map(n => n.name)).toEqual(['a', 'c', 'top.mp3']);
    const a = tree[0];
    expect(a.fileCount).toBe(2);
    expect(a.annotatedCount).toBe(1);
    expect(a.children.map(n => n.name)).toEqual(['x.mp3', 'b']);
  });
  it('attaches non-media files to their folder, skipping root-level ones', () => {
    const tree = build(['/r/a/notes.txt', '/r/readme.txt']);
    expect(tree[0].nonMediaFiles).toEqual(['/r/a/notes.txt']);
    expect(tree[2].nonMediaFiles).toBeUndefined();
  });
  it('lists dirs and ancestors', () => {
    expect(getAllDirPaths(build())).toEqual(['/r/a', '/r/a/b', '/r/c']);
    expect([...getAncestorPaths('/r/a/b/y.mp3', '/r')]).toEqual(['/r/a', '/r/a/b']);
    expect(getAncestorPaths(null, '/r').size).toBe(0);
  });
});

describe('filterUnderDir', () => {
  it('accepts either separator', () => {
    expect(filterUnderDir(['C:\\r\\a\\x.mp3', 'C:\\r\\ab\\y.mp3'], 'C:/r/a')).toEqual(['C:\\r\\a\\x.mp3']);
  });
});

describe('toggleDirInSet', () => {
  it('expands an unbranched chain at once and collapses the subtree', () => {
    const tree = buildTree('/r', ['/r/a/b/c/x.mp3'], [], new Set(), new Set(), []);
    const open = toggleDirInSet(new Set(), tree[0]);
    expect([...open].sort()).toEqual(['/r/a', '/r/a/b', '/r/a/b/c']);
    expect(toggleDirInSet(open, tree[0]).size).toBe(0);
  });
  it('stops at a branch', () => {
    const open = toggleDirInSet(new Set(), build()[0]);
    expect([...open]).toEqual(['/r/a']);
  });
});

describe('flattenTree', () => {
  it('emits only rows under expanded folders, with non-media disclosures', () => {
    const tree = build(['/r/a/notes.txt']);
    const closed = flattenTree(tree, '/r', new Set(), new Set(), ['/r/root.txt']);
    expect(closed.map(r => r.kind)).toEqual(['dir', 'dir', 'file', 'nonMediaToggle']);
    const open = flattenTree(tree, '/r', new Set(['/r/a']), new Set(['/r/a']), []);
    expect(open.map(r => r.key)).toEqual(['/r/a', '/r/a/x.mp3', '/r/a/b', 'nm:/r/a', 'nmi:/r/a/notes.txt', '/r/c', '/r/top.mp3']);
    expect(open[1]).toMatchObject({ depth: 1, parentPath: '/r/a' });
  });
});
