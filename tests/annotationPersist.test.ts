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
