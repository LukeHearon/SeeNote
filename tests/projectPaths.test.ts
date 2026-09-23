import { describe, it, expect } from 'vitest';
import {
  basename,
  isAbsolutePath,
  resolveInputPath,
  trimProjectPrefix,
  resolveProjectPath,
  isInsideProjectDir,
  isInsideDir,
  makeProjectPath,
  normalizePath,
  inputToProjectPath,
  projectPathInput,
  MAX_RELATIVE_UPS,
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

describe('isInsideDir', () => {
  it('returns true for a strict descendant', () => {
    expect(isInsideDir('/a/folder', '/a/folder/sub/clip.wav')).toBe(true);
  });

  it('returns false for the dir itself', () => {
    expect(isInsideDir('/a/folder', '/a/folder')).toBe(false);
  });

  it('returns false for a sibling sharing the prefix', () => {
    expect(isInsideDir('/a/foo', '/a/foobar/x')).toBe(false);
  });

  it('handles a trailing slash and backslash descendants', () => {
    expect(isInsideDir('/a/folder/', '/a/folder/x')).toBe(true);
    expect(isInsideDir('/a/folder', '/a/folder\\x')).toBe(true);
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

describe('normalizePath', () => {
  it('returns paths without dot segments unchanged', () => {
    expect(normalizePath('/a/b/c')).toBe('/a/b/c');
    expect(normalizePath('C:\\a\\b')).toBe('C:\\a\\b');
  });

  it('collapses .. and . segments', () => {
    expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
  });

  it('never climbs above the root', () => {
    expect(normalizePath('/a/../../b')).toBe('/b');
    expect(normalizePath('~/../x')).toBe('~/x');
  });

  it('keeps leading .. on relative paths', () => {
    expect(normalizePath('../../a/../b')).toBe('../../b');
    expect(normalizePath('./a/..')).toBe('.');
  });

  it('keeps the first separator style (windows)', () => {
    expect(normalizePath('C:\\proj/../audio')).toBe('C:\\audio');
  });
});

describe('outside-project paths', () => {
  it('resolves a ../ relative path to a normalized absolute path', () => {
    expect(resolveProjectPath(PROJ, { kind: 'relative', path: '../audio' }))
      .toBe('/Users/me/projects/audio');
    expect(resolveProjectPath(PROJ, { kind: 'relative', path: './../audio' }))
      .toBe('/Users/me/projects/audio');
    expect(resolveInputPath(PROJ, '../audio')).toBe('/Users/me/projects/audio');
  });

  it('does not treat a ../ path as inside the project', () => {
    expect(isInsideProjectDir(PROJ, resolveInputPath(PROJ, '../audio'))).toBe(false);
  });

  it('stores a sibling as ../', () => {
    expect(makeProjectPath(PROJ, '/Users/me/projects/audio'))
      .toEqual({ kind: 'relative', path: '../audio' });
  });

  it('stores up to MAX_RELATIVE_UPS levels up as relative', () => {
    expect(MAX_RELATIVE_UPS).toBe(2);
    const proj = '/data/lab/exp1/proj';
    expect(makeProjectPath(proj, '/data/lab/raw/audio'))
      .toEqual({ kind: 'relative', path: '../../raw/audio' });
    expect(makeProjectPath(proj, '/data/other/audio'))
      .toEqual({ kind: 'absolute', path: '/data/other/audio' });
  });

  it('keeps long descending tails relative', () => {
    expect(makeProjectPath(PROJ, '/Users/me/projects/data/raw/audio/2026/site_a'))
      .toEqual({ kind: 'relative', path: '../data/raw/audio/2026/site_a' });
  });

  it('stores absolute when the shared ancestor is home or a top-level dir', () => {
    // Shared ancestor is ~ (/Users/me).
    expect(makeProjectPath('/Users/me/Documents/proj', '/Users/me/Downloads/audio'))
      .toEqual({ kind: 'absolute', path: '/Users/me/Downloads/audio' });
    // Shared ancestor is /Volumes (different drives).
    expect(makeProjectPath('/Volumes/a/proj', '/Volumes/b/audio'))
      .toEqual({ kind: 'absolute', path: '/Volumes/b/audio' });
    expect(makeProjectPath('C:\\Users\\me\\proj', 'D:\\audio'))
      .toEqual({ kind: 'absolute', path: 'D:\\audio' });
    expect(makeProjectPath('/home/me/proj', '/home/me/audio'))
      .toEqual({ kind: 'absolute', path: '/home/me/audio' });
  });

  it('allows a shared ancestor that is a drive folder', () => {
    expect(makeProjectPath('/Volumes/data/proj', '/Volumes/data/audio'))
      .toEqual({ kind: 'relative', path: '../audio' });
  });

  it('round-trips a nearby outside path', () => {
    const abs = '/Users/me/projects/audio';
    expect(resolveProjectPath(PROJ, makeProjectPath(PROJ, abs))).toBe(abs);
  });
});

describe('inputToProjectPath / projectPathInput', () => {
  it('keeps typed relative paths relative, however far up', () => {
    expect(inputToProjectPath(PROJ, '../../../../x'))
      .toEqual({ kind: 'relative', path: '../../../../x' });
  });

  it('stores typed children with a ./ prefix', () => {
    expect(inputToProjectPath(PROJ, 'audio')).toEqual({ kind: 'relative', path: './audio' });
    expect(inputToProjectPath(PROJ, '.')).toEqual({ kind: 'relative', path: './' });
  });

  it('applies the cap to typed absolute paths', () => {
    expect(inputToProjectPath(PROJ, '/Users/me/projects/audio'))
      .toEqual({ kind: 'relative', path: '../audio' });
    expect(inputToProjectPath(PROJ, '/elsewhere/audio'))
      .toEqual({ kind: 'absolute', path: '/elsewhere/audio' });
  });

  it('round-trips stored paths through the field value', () => {
    for (const p of [
      { kind: 'relative', path: './audio' },
      { kind: 'relative', path: './' },
      { kind: 'relative', path: '../../../x' },
      { kind: 'absolute', path: '/elsewhere/audio' },
    ] as const) {
      expect(inputToProjectPath(PROJ, projectPathInput(p))).toEqual(p);
    }
  });
});
