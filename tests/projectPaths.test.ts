import { describe, it, expect } from 'vitest';
import {
  basename,
  isAbsolutePath,
  resolveInputPath,
  trimProjectPrefix,
  resolveProjectPath,
  isInsideProjectDir,
  makeProjectPath,
} from '../utils/projectPaths';

const PROJ = '/Users/me/projects/birdsong';

describe('basename', () => {
  it('returns the last segment of a unix path', () => {
    expect(basename('/Users/me/projects/birdsong/audio.wav')).toBe('audio.wav');
  });

  it('ignores a trailing slash', () => {
    expect(basename('/Users/me/projects/birdsong/')).toBe('birdsong');
  });

  it('ignores a trailing backslash', () => {
    expect(basename('C:\\Users\\me\\proj\\')).toBe('proj');
  });

  it('handles windows-style separators', () => {
    expect(basename('C:\\Users\\me\\proj\\file.wav')).toBe('file.wav');
  });

  it('returns the string itself when no separator is present', () => {
    expect(basename('audio.wav')).toBe('audio.wav');
  });

  it('returns empty string for empty input', () => {
    expect(basename('')).toBe('');
  });
});

describe('isAbsolutePath', () => {
  it('treats a leading slash as absolute', () => {
    expect(isAbsolutePath('/Users/me/foo')).toBe(true);
  });

  it('treats a home-relative path as absolute', () => {
    expect(isAbsolutePath('~/foo')).toBe(true);
  });

  it('treats a windows drive path as absolute', () => {
    expect(isAbsolutePath('C:\\Users\\me')).toBe(true);
    expect(isAbsolutePath('D:/data')).toBe(true);
  });

  it('treats a bare segment as not absolute', () => {
    expect(isAbsolutePath('foo/bar')).toBe(false);
  });

  it('treats a dot-prefixed path as not absolute', () => {
    expect(isAbsolutePath('./foo')).toBe(false);
  });

  it('treats empty string as not absolute', () => {
    expect(isAbsolutePath('')).toBe(false);
  });
});

describe('resolveInputPath', () => {
  it('returns absolute input untouched', () => {
    expect(resolveInputPath(PROJ, '/elsewhere/data')).toBe('/elsewhere/data');
  });

  it('joins a relative input under the project dir', () => {
    expect(resolveInputPath(PROJ, 'audio')).toBe(`${PROJ}/audio`);
  });

  it('strips a trailing slash from the project dir before joining', () => {
    expect(resolveInputPath(PROJ + '/', 'audio')).toBe(`${PROJ}/audio`);
  });

  it('returns empty string for empty input', () => {
    expect(resolveInputPath(PROJ, '')).toBe('');
  });
});

describe('trimProjectPrefix', () => {
  it('strips the project prefix from a child path', () => {
    expect(trimProjectPrefix(PROJ, `${PROJ}/audio/clip.wav`)).toBe('audio/clip.wav');
  });

  it('returns the path unchanged when outside the project dir', () => {
    expect(trimProjectPrefix(PROJ, '/elsewhere/data.wav')).toBe('/elsewhere/data.wav');
  });

  it('handles a trailing slash on the project dir', () => {
    expect(trimProjectPrefix(PROJ + '/', `${PROJ}/audio/clip.wav`)).toBe('audio/clip.wav');
  });

  it('strips the prefix even when the descendant uses a backslash separator', () => {
    expect(trimProjectPrefix(PROJ, `${PROJ}\\audio\\clip.wav`)).toBe('audio\\clip.wav');
  });

  it('returns input unchanged when either argument is empty', () => {
    expect(trimProjectPrefix('', '/some/path')).toBe('/some/path');
    expect(trimProjectPrefix(PROJ, '')).toBe('');
  });

  it('does not strip when the path is a sibling whose name starts with the project name', () => {
    // projectDir is '/a/foo', sibling is '/a/foobar' — must NOT match.
    expect(trimProjectPrefix('/a/foo', '/a/foobar/x')).toBe('/a/foobar/x');
  });
});

describe('resolveProjectPath', () => {
  it('returns absolute ProjectPath untouched', () => {
    expect(resolveProjectPath(PROJ, { kind: 'absolute', path: '/elsewhere/data' }))
      .toBe('/elsewhere/data');
  });

  it('joins a relative ProjectPath under the project dir', () => {
    expect(resolveProjectPath(PROJ, { kind: 'relative', path: 'audio' }))
      .toBe(`${PROJ}/audio`);
  });

  it('strips a leading ./ from a relative ProjectPath', () => {
    expect(resolveProjectPath(PROJ, { kind: 'relative', path: './audio' }))
      .toBe(`${PROJ}/audio`);
  });

  it('returns the project dir itself for relative ./', () => {
    expect(resolveProjectPath(PROJ, { kind: 'relative', path: './' }))
      .toBe(PROJ);
  });

  it('handles a trailing slash on the project dir', () => {
    expect(resolveProjectPath(PROJ + '/', { kind: 'relative', path: './audio' }))
      .toBe(`${PROJ}/audio`);
  });
});

describe('isInsideProjectDir', () => {
  it('returns true for the project dir itself', () => {
    expect(isInsideProjectDir(PROJ, PROJ)).toBe(true);
  });

  it('returns true for a strict descendant', () => {
    expect(isInsideProjectDir(PROJ, `${PROJ}/audio/clip.wav`)).toBe(true);
  });

  it('returns false for a sibling path outside the project', () => {
    expect(isInsideProjectDir(PROJ, '/Users/me/projects/other/clip.wav')).toBe(false);
  });

  it('returns false for a sibling whose name shares the project prefix', () => {
    expect(isInsideProjectDir('/a/foo', '/a/foobar/x')).toBe(false);
  });

  it('handles a trailing slash on the project dir', () => {
    expect(isInsideProjectDir(PROJ + '/', `${PROJ}/audio`)).toBe(true);
  });

  it('accepts a backslash-separated descendant (windows)', () => {
    expect(isInsideProjectDir(PROJ, `${PROJ}\\audio`)).toBe(true);
  });
});

describe('makeProjectPath', () => {
  it('returns relative ./ when the path equals the project dir', () => {
    expect(makeProjectPath(PROJ, PROJ)).toEqual({ kind: 'relative', path: './' });
  });

  it('returns a relative path with ./ prefix for a descendant', () => {
    expect(makeProjectPath(PROJ, `${PROJ}/audio/clip.wav`))
      .toEqual({ kind: 'relative', path: './audio/clip.wav' });
  });

  it('returns absolute for a path outside the project dir', () => {
    expect(makeProjectPath(PROJ, '/elsewhere/data.wav'))
      .toEqual({ kind: 'absolute', path: '/elsewhere/data.wav' });
  });

  it('handles a trailing slash on the project dir', () => {
    expect(makeProjectPath(PROJ + '/', `${PROJ}/audio`))
      .toEqual({ kind: 'relative', path: './audio' });
  });
});

describe('round-trip: resolveProjectPath(makeProjectPath(absPath))', () => {
  it('round-trips a path inside the project dir', () => {
    const abs = `${PROJ}/audio/clip.wav`;
    expect(resolveProjectPath(PROJ, makeProjectPath(PROJ, abs))).toBe(abs);
  });

  it('round-trips a path outside the project dir', () => {
    const abs = '/elsewhere/data.wav';
    expect(resolveProjectPath(PROJ, makeProjectPath(PROJ, abs))).toBe(abs);
  });

  it('round-trips the project dir itself', () => {
    expect(resolveProjectPath(PROJ, makeProjectPath(PROJ, PROJ))).toBe(PROJ);
  });

  it('round-trips when the project dir has a trailing slash on the make side', () => {
    const abs = `${PROJ}/annotations`;
    expect(resolveProjectPath(PROJ, makeProjectPath(PROJ + '/', abs))).toBe(abs);
  });
});
