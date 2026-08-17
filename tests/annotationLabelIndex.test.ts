import { describe, it, expect, vi, beforeEach } from 'vitest';

const files: Record<string, string> = {
  '/annot/a.txt': '0\t1\tbee\n1\t2\twasp\n',
  '/annot/b.txt': '0\t1\tbee\n',
  // c has no annotation file — readTextFile rejects, as the Tauri command does.
};

vi.mock('../utils/tauriCommands', () => ({
  readTextFile: vi.fn((path: string) => (
    path in files ? Promise.resolve(files[path]) : Promise.reject(new Error('no such file'))
  )),
  writeTextFile: vi.fn(() => Promise.resolve()),
}));

import { readTextFile, writeTextFile } from '../utils/tauriCommands';
import {
  loadProjectLabels,
  candidateTracks,
  invalidateProjectLabelIndex,
  renameLabelAcrossTracks,
  TrackLabels,
} from '../utils/annotationRename';
import { exactLabelMatcher } from '../utils/helpers';

const tracks = ['/media/a.wav', '/media/b.wav', '/media/c.wav'];
const getAnnotationPath = (t: string) => `/annot/${t.slice('/media/'.length, -4)}.txt`;
const getIdent = (t: string) => t.slice('/media/'.length, -4);

const collect = async (list = tracks): Promise<TrackLabels[]> => {
  const out: TrackLabels[] = [];
  await loadProjectLabels(list, getAnnotationPath, getIdent, e => out.push(e));
  return out;
};

describe('project label index', () => {
  beforeEach(() => {
    invalidateProjectLabelIndex();
    vi.mocked(readTextFile).mockClear();
    vi.mocked(writeTextFile).mockClear();
  });

  it('reads every track once and reports only those with labels', async () => {
    const entries = await collect();
    expect(entries.map(e => e.ident)).toEqual(['a', 'b']);
    expect(entries[0].labels.map(l => l.label)).toEqual(['bee', 'wasp']);
    expect(readTextFile).toHaveBeenCalledTimes(3);
  });

  it('serves a second load from memory without touching disk', async () => {
    await collect();
    vi.mocked(readTextFile).mockClear();
    const entries = await collect();
    expect(entries.map(e => e.ident)).toEqual(['a', 'b']);
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('re-reads after invalidation', async () => {
    await collect();
    invalidateProjectLabelIndex();
    vi.mocked(readTextFile).mockClear();
    await collect();
    expect(readTextFile).toHaveBeenCalledTimes(3);
  });

  it('re-reads when the track list changes', async () => {
    await collect();
    vi.mocked(readTextFile).mockClear();
    await collect([...tracks, '/media/d.wav']);
    expect(readTextFile).toHaveBeenCalledTimes(4);
  });

  it('narrows rename candidates to indexed matches, including a subset of the indexed tracks', async () => {
    await collect();
    expect(candidateTracks(tracks, exactLabelMatcher('wasp'))).toEqual(['/media/a.wav']);
    // The rename callers pass every track but the open one.
    const others = tracks.filter(t => t !== '/media/a.wav');
    expect(candidateTracks(others, exactLabelMatcher('bee'))).toEqual(['/media/b.wav']);
  });

  it('falls back to every track when the index has not seen them all', async () => {
    expect(candidateTracks(tracks, exactLabelMatcher('bee'))).toEqual(tracks);
    await collect();
    const withUnknown = [...tracks, '/media/d.wav'];
    expect(candidateTracks(withUnknown, exactLabelMatcher('bee'))).toEqual(withUnknown);
  });

  it('renames only the files the index points at, and drops the index', async () => {
    await collect();
    vi.mocked(readTextFile).mockClear();
    const count = await renameLabelAcrossTracks(tracks, getAnnotationPath, exactLabelMatcher('wasp'), 'hornet');
    expect(count).toBe(1);
    // Only a.txt is opened; b and c are known not to match.
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith('/annot/a.txt', '0\t1\tbee\n1\t2\thornet\n');
    // The index described files that just changed, so it is gone.
    vi.mocked(readTextFile).mockClear();
    await collect();
    expect(readTextFile).toHaveBeenCalledTimes(3);
  });
});
