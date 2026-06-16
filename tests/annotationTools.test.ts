import { describe, it, expect } from 'vitest';
import {
  CUSTOM_TOOL_ID,
  ANNOTATION_TOOLS_RELATIVE_DIR,
  resolveAnnotationToolsDir,
  makeCustomTool,
  assembleTools,
  buildHotkeyMap,
  mergeImportedTools,
  toPersistedTools,
  diffToolFolders,
  PersistedTool,
} from '../utils/annotationTools';
import type { FolderTool } from '../utils/tauriCommands';

const folder = (name: string, color = '#111111', description = '', example_files: string[] = []): FolderTool =>
  ({ name, color, description, example_files });

const pt = (id: string, text: string, color = '#111111', description = ''): PersistedTool =>
  ({ id, text, color, description });

describe('annotation tools directory', () => {
  it('is fixed under the project .seenote directory', () => {
    expect(ANNOTATION_TOOLS_RELATIVE_DIR).toBe('./.seenote/annotation-tools');
    expect(resolveAnnotationToolsDir('/tmp/project/')).toBe('/tmp/project/.seenote/annotation-tools');
  });
});

describe('makeCustomTool', () => {
  it('is key "0" with the given color and the custom sentinel id', () => {
    expect(makeCustomTool('#abc123')).toEqual({
      id: CUSTOM_TOOL_ID, key: '0', text: 'Custom', color: '#abc123', description: '',
    });
  });
});

describe('assembleTools', () => {
  it('puts Custom first, then folder tools in scan order', () => {
    const tools = assembleTools([folder('a'), folder('b')], {}, '#fff', n => `id-${n}`);
    expect(tools.map(t => t.text)).toEqual(['Custom', 'a', 'b']);
    expect(tools[0].id).toBe(CUSTOM_TOOL_ID);
    expect(tools[1].id).toBe('id-a');
  });

  it('looks up hotkeys by label; unbound tools get key null', () => {
    const tools = assembleTools([folder('a'), folder('b')], { b: '3' }, '#fff', n => n);
    expect(tools.find(t => t.text === 'a')!.key).toBeNull();
    expect(tools.find(t => t.text === 'b')!.key).toBe('3');
  });

  it('carries color, description, and example files through', () => {
    const tools = assembleTools(
      [folder('a', '#ff0000', 'memo', ['/x/clip1.mp3'])], {}, '#fff', n => n,
    );
    expect(tools[1]).toMatchObject({ color: '#ff0000', description: 'memo', exampleFiles: ['/x/clip1.mp3'] });
  });

  it('maps an empty folder description to undefined', () => {
    const tools = assembleTools([folder('a')], {}, '#fff', n => n);
    expect(tools[1].description).toBeUndefined();
  });
});

describe('buildHotkeyMap', () => {
  it('maps label → key for keyed tools, excluding Custom (key "0") and unassigned', () => {
    expect(buildHotkeyMap([
      { key: '0', text: 'Custom' },
      { key: '1', text: 'bee' },
      { key: null, text: 'rain' },
      { key: '9', text: 'frog' },
    ])).toEqual({ bee: '1', frog: '9' });
  });

  it('round-trips with assembleTools', () => {
    const hotkeys = { a: '1', c: '5' };
    const tools = assembleTools([folder('a'), folder('b'), folder('c')], hotkeys, '#fff', n => n);
    expect(buildHotkeyMap(tools)).toEqual(hotkeys);
  });
});

describe('mergeImportedTools', () => {
  const current = () => assembleTools([folder('a', '#aa0000')], { a: '1' }, '#fff', n => `id-${n}`);

  it('appends new labels unkeyed, preserving existing tools in place', () => {
    const { tools, added } = mergeImportedTools(
      current(), [folder('a', '#aa0000'), folder('b', '#bb0000')], n => `new-${n}`,
    );
    expect(tools.map(t => t.text)).toEqual(['Custom', 'a', 'b']);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: 'new-b', key: null, text: 'b', color: '#bb0000' });
  });

  it('refreshes exampleFiles of existing labels but keeps their in-memory key/color/description', () => {
    const { tools, added } = mergeImportedTools(
      current(),
      // disk says different color (in-memory edit pending) + a new clip
      [folder('a', '#dd0000', 'disk memo', ['/a/new.mp3'])],
      n => n,
    );
    expect(added).toEqual([]);
    expect(tools.find(t => t.text === 'a')).toMatchObject({
      id: 'id-a', key: '1', color: '#aa0000', exampleFiles: ['/a/new.mp3'],
    });
  });

  it('never touches the Custom tool', () => {
    const { tools } = mergeImportedTools(current(), [folder('b')], n => n);
    expect(tools[0]).toEqual(makeCustomTool('#fff'));
  });
});

describe('toPersistedTools', () => {
  it('drops Custom and the key/exampleFiles fields; defaults description to ""', () => {
    const tools = assembleTools([folder('a', '#222222', '', ['/c.mp3'])], { a: '2' }, '#fff', n => n);
    expect(toPersistedTools(tools)).toEqual([pt('a', 'a', '#222222', '')]);
  });
});

describe('diffToolFolders', () => {
  it('is empty for identical snapshots', () => {
    const snap = [pt('1', 'a'), pt('2', 'b')];
    expect(diffToolFolders(snap, snap)).toEqual({ creates: [], renames: [], updates: [], deletes: [] });
  });

  it('detects creates (id only in next)', () => {
    const ops = diffToolFolders([pt('1', 'a')], [pt('1', 'a'), pt('2', 'b')]);
    expect(ops.creates).toEqual([pt('2', 'b')]);
    expect(ops.renames).toEqual([]);
    expect(ops.deletes).toEqual([]);
  });

  it('detects deletes by the previous folder name', () => {
    const ops = diffToolFolders([pt('1', 'a'), pt('2', 'b')], [pt('1', 'a')]);
    expect(ops.deletes).toEqual(['b']);
  });

  it('a label change on the same id is a rename, not delete+create', () => {
    const ops = diffToolFolders([pt('1', 'old')], [pt('1', 'new')]);
    expect(ops.renames).toEqual([{ from: 'old', to: 'new' }]);
    expect(ops.creates).toEqual([]);
    expect(ops.deletes).toEqual([]);
    expect(ops.updates).toEqual([]);
  });

  it('a color or description change is an update carrying the new values', () => {
    const ops = diffToolFolders([pt('1', 'a', '#111111', 'x')], [pt('1', 'a', '#222222', 'y')]);
    expect(ops.updates).toEqual([pt('1', 'a', '#222222', 'y')]);
    expect(ops.renames).toEqual([]);
  });

  it('rename + recolor on the same id yields both ops, update under the new name', () => {
    const ops = diffToolFolders([pt('1', 'old', '#111111')], [pt('1', 'new', '#222222')]);
    expect(ops.renames).toEqual([{ from: 'old', to: 'new' }]);
    expect(ops.updates).toEqual([pt('1', 'new', '#222222', '')]);
  });

  it('a same-label tool with a new id (delete + recreate via undo) is create + delete', () => {
    const ops = diffToolFolders([pt('1', 'a')], [pt('2', 'a')]);
    expect(ops.creates).toEqual([pt('2', 'a')]);
    expect(ops.deletes).toEqual(['a']);
  });
});
