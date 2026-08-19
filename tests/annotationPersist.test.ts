import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Annotation } from '../types';

vi.mock('../utils/tauriCommands', () => ({
  writeTextFile: vi.fn(() => Promise.resolve()),
  removeFile: vi.fn(() => Promise.resolve()),
  saveFileDialog: vi.fn(),
  listDirectory: vi.fn(),
}));

import { writeTextFile, removeFile } from '../utils/tauriCommands';
import { persistAnnotations } from '../utils/annotationPersist';

const ann = (start: number, end: number, text = 'label'): Annotation => ({
  id: 'id-' + start + '-' + end,
  start,
  end,
  text,
  color: undefined,
});

describe('persistAnnotations', () => {
  beforeEach(() => {
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(removeFile).mockClear();
  });

  it('writes the serialized content for a non-empty list', async () => {
    const result = await persistAnnotations('/x/a.txt', [ann(0, 1, 'bee')], 4);
    expect(result).toBe('written');
    expect(writeTextFile).toHaveBeenCalledWith('/x/a.txt', '0.0000\t1.0000\tbee\n');
    expect(removeFile).not.toHaveBeenCalled();
  });

  it('removes the file for an empty list — never writes a 0-byte file', async () => {
    const result = await persistAnnotations('/x/a.txt', [], 4);
    expect(result).toBe('removed');
    expect(removeFile).toHaveBeenCalledWith('/x/a.txt');
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveFlushTarget — the guard that decides whether a flush may touch disk.
//
// Regression cover for the bug that deleted two annotated recordings from a
// shared project and pushed the deletion to every collaborator: the flush read
// the track from one ref and the annotation list from another, and the list
// lagged by a render. A flush landing in that window paired a real, hydrated
// track with the empty placeholder left by the track switch — and an empty list
// removes the file. Pairing them in one value is what makes that state
// unrepresentable, so these tests pin that the pairing is never split.
// ---------------------------------------------------------------------------

import { resolveFlushTarget } from '../utils/annotationPersist';

const pathFor = (track: string) => '/ann' + track.replace(/^\/audio/, '') + '.txt';

describe('resolveFlushTarget', () => {
  const loaded = { trackPath: '/audio/a.wav', annotations: [ann(1, 2, 'bee')] };

  it('resolves the hydrated track to its annotation path and list', () => {
    expect(resolveFlushTarget(loaded, '/audio/a.wav', pathFor)).toEqual({
      annotPath: '/ann/a.wav.txt',
      annotations: loaded.annotations,
    });
  });

  it('writes nothing while no track is hydrated (mid-load / just switched)', () => {
    expect(resolveFlushTarget(null, '/audio/a.wav', pathFor)).toBeNull();
  });

  it('writes nothing when the hydrated track is not the open one', () => {
    // The user moved on; this list is not what is on screen.
    expect(resolveFlushTarget(loaded, '/audio/b.wav', pathFor)).toBeNull();
  });

  it('writes nothing when no track is open at all', () => {
    expect(resolveFlushTarget(loaded, null, pathFor)).toBeNull();
  });

  it('writes nothing when the track has no resolvable annotation path', () => {
    expect(resolveFlushTarget(loaded, '/audio/a.wav', () => null)).toBeNull();
  });

  it('carries the list belonging to the named track, never a caller-supplied one', () => {
    // The regression in one assertion: the ONLY list reachable from a resolved
    // target is the one stored alongside that track. There is no second source
    // a stale placeholder could arrive from.
    const target = resolveFlushTarget(loaded, '/audio/a.wav', pathFor);
    expect(target?.annotations).toBe(loaded.annotations);
  });

  it('passes through a genuinely emptied track so the file is deleted', async () => {
    // An empty list HERE is real: the track was loaded and the user removed
    // every annotation. Deleting the file is the correct outcome — the guard
    // must not block it, or clearing a track would silently do nothing.
    const emptied = { trackPath: '/audio/a.wav', annotations: [] };
    const target = resolveFlushTarget(emptied, '/audio/a.wav', pathFor);
    expect(target).toEqual({ annotPath: '/ann/a.wav.txt', annotations: [] });

    vi.mocked(removeFile).mockClear();
    await persistAnnotations(target!.annotPath, target!.annotations, 4);
    expect(removeFile).toHaveBeenCalledWith('/ann/a.wav.txt');
  });
});
