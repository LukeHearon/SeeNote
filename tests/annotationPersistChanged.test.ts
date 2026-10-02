import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Annotation } from '../types';

vi.mock('../utils/tauriCommands', () => ({
  writeTextFile: vi.fn(() => Promise.resolve()),
  checkFileExists: vi.fn(() => Promise.resolve(true)),
}));

import { writeTextFile, checkFileExists } from '../utils/tauriCommands';
import {
  annotationFileContent,
  persistAnnotations,
  persistAnnotationsIfChanged,
  rememberDiskContent,
  recallDiskContent,
} from '../utils/annotationPersist';

const ann = (start: number, end: number, text = 'label'): Annotation => ({
  id: 'id-' + start + '-' + end,
  start,
  end,
  text,
  color: undefined,
});

describe('persistAnnotationsIfChanged', () => {
  beforeEach(() => {
    vi.mocked(writeTextFile).mockReset();
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    vi.mocked(checkFileExists).mockResolvedValue(true);
  });

  it('skips a write that would change nothing', async () => {
    const list = [ann(0, 1, 'bee')];
    rememberDiskContent('/x/same.txt', annotationFileContent(list, 4));
    expect(await persistAnnotationsIfChanged('/x/same.txt', list, 4)).toBe('unchanged');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('never skips a real edit, however soon after the load', async () => {
    rememberDiskContent('/x/edit.txt', annotationFileContent([ann(0, 1, 'bee')], 4));
    const edited = [ann(0, 1, 'bee'), ann(2, 3, 'fly')];
    expect(await persistAnnotationsIfChanged('/x/edit.txt', edited, 4)).toBe('written');
    expect(recallDiskContent('/x/edit.txt')).toBe(annotationFileContent(edited, 4));
  });

  it('writes when nothing is known about the file', async () => {
    expect(await persistAnnotationsIfChanged('/x/unknown.txt', [ann(0, 1, 'bee')], 4)).toBe('written');
  });

  it('treats an unnamed-only list as equal to an empty known file', async () => {
    rememberDiskContent('/x/empty.txt', '');
    expect(await persistAnnotationsIfChanged('/x/empty.txt', [ann(0, 1, '')], 4)).toBe('unchanged');
  });

  it('forgets the known content when a write fails', async () => {
    rememberDiskContent('/x/fail.txt', 'old');
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk'));
    await expect(persistAnnotations('/x/fail.txt', [ann(0, 1, 'bee')], 4)).rejects.toThrow();
    expect(recallDiskContent('/x/fail.txt')).toBeUndefined();
  });
});

describe('write ordering', () => {
  it('lands writes in call order even when an earlier one is slower', async () => {
    const landed: string[] = [];
    let releaseFirst!: () => void;
    vi.mocked(writeTextFile).mockReset();
    vi.mocked(writeTextFile)
      .mockImplementationOnce(async (_p: string, c: string) => {
        await new Promise<void>(r => { releaseFirst = r; });
        landed.push(c);
      })
      .mockImplementation(async (_p: string, c: string) => { landed.push(c); });
    const first = persistAnnotations('/x/o.txt', [ann(0, 1, 'one')], 4);
    const second = persistAnnotations('/x/o.txt', [ann(0, 1, 'two')], 4);
    await Promise.resolve();
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(landed).toEqual(['0.0000\t1.0000\tone\n', '0.0000\t1.0000\ttwo\n']);
  });
});
