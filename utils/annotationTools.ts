// Pure logic for the folder-backed annotation tool model.
//
// Tools live as folders under {projectDir}/.seenote/annotation-tools/ — the
// folder NAME is the label (the exact text written into annotation .txt files)
// and therefore the durable identity. The in-memory AnnotationTool[] remains
// the session source of truth; these helpers assemble it from a folder scan on
// load and diff it back into folder operations on change. Hotkeys are
// project-level (settings.toolHotkeys), not stored in the folders.

import { AnnotationTool } from '../types';
import type { FolderTool } from './tauriCommands';

export const ANNOTATION_TOOLS_RELATIVE_DIR = './.seenote/annotation-tools';

export const resolveAnnotationToolsDir = (projectDir: string): string =>
  projectDir.replace(/[/\\]+$/, '') + '/' + ANNOTATION_TOOLS_RELATIVE_DIR.replace(/^\.\//, '');

/** Sentinel `id` of the synthetic Custom tool (key "0") — never a folder. */
export const CUSTOM_TOOL_ID = 'custom';

export const makeCustomTool = (color: string): AnnotationTool => ({
  id: CUSTOM_TOOL_ID,
  key: '0',
  text: 'Custom',
  color,
  description: '',
});

const fromFolderTool = (ft: FolderTool, key: string | null, id: string): AnnotationTool => ({
  id,
  key,
  text: ft.name,
  color: ft.color,
  description: ft.description || undefined,
  exampleFiles: ft.example_files,
});

/**
 * Build the in-memory tool array from a folder scan: Custom first, then the
 * folder tools (already label-sorted by the Rust scan) with hotkeys looked up
 * by label. `idFor` mints the session-stable id for each folder tool.
 */
export const assembleTools = (
  folderTools: FolderTool[],
  hotkeys: Record<string, string>,
  customColor: string,
  idFor: (name: string) => string,
): AnnotationTool[] => [
  makeCustomTool(customColor),
  ...folderTools.map(ft => fromFolderTool(ft, hotkeys[ft.name] ?? null, idFor(ft.name))),
];

/**
 * Fold a fresh folder scan into the current in-memory tools after an import:
 * labels that already exist keep all their in-memory state (only their
 * `exampleFiles` refresh from the scan); new labels are appended unkeyed.
 * Returns the merged array plus the appended tools — the caller must also add
 * those to its persisted snapshot so the reconcile diff doesn't try to
 * re-create folders that the import just wrote.
 */
export const mergeImportedTools = (
  current: AnnotationTool[],
  folderTools: FolderTool[],
  idFor: (name: string) => string,
): { tools: AnnotationTool[]; added: AnnotationTool[] } => {
  const byText = new Map(folderTools.map(ft => [ft.name, ft]));
  const tools = current.map(t => {
    if (t.id === CUSTOM_TOOL_ID) return t;
    const ft = byText.get(t.text);
    return ft ? { ...t, exampleFiles: ft.example_files } : t;
  });
  const existingTexts = new Set(current.map(t => t.text));
  const added = folderTools
    .filter(ft => !existingTexts.has(ft.name))
    .map(ft => fromFolderTool(ft, null, idFor(ft.name)));
  return { tools: [...tools, ...added], added };
};

/** Label → hotkey for keyed, non-Custom tools. Inverse of the assemble lookup. */
export const buildHotkeyMap = (
  tools: Pick<AnnotationTool, 'key' | 'text'>[],
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const t of tools) {
    if (t.key !== null && t.key !== '0') map[t.text] = t.key;
  }
  return map;
};

/** The folder-persisted projection of a tool (no key, no exampleFiles). */
export interface PersistedTool {
  id: string;
  text: string;
  color: string;
  description: string;
}

export const toPersistedTools = (tools: AnnotationTool[]): PersistedTool[] =>
  tools
    .filter(t => t.id !== CUSTOM_TOOL_ID)
    .map(t => ({ id: t.id, text: t.text, color: t.color, description: t.description ?? '' }));

export interface ToolFolderOps {
  creates: PersistedTool[];
  /** Folder renames, keyed by old name. Apply order: deletes, renames, creates, updates. */
  renames: { from: string; to: string }[];
  /** Color/description rewrites; `text` is the post-rename folder name. */
  updates: PersistedTool[];
  /** Folder names to delete. */
  deletes: string[];
}

/**
 * Diff two persisted-tool snapshots by `id` into the folder operations that
 * turn `prev` into `next`. A tool present in both with a changed label yields
 * a rename (preserving the folder's example clips); changed color/description
 * yields an update; the two can co-occur.
 */
export const diffToolFolders = (prev: PersistedTool[], next: PersistedTool[]): ToolFolderOps => {
  const prevById = new Map(prev.map(t => [t.id, t]));
  const nextIds = new Set(next.map(t => t.id));
  const ops: ToolFolderOps = { creates: [], renames: [], updates: [], deletes: [] };
  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p) {
      ops.creates.push(n);
      continue;
    }
    if (p.text !== n.text) ops.renames.push({ from: p.text, to: n.text });
    if (p.color !== n.color || p.description !== n.description) ops.updates.push(n);
  }
  for (const p of prev) {
    if (!nextIds.has(p.id)) ops.deletes.push(p.text);
  }
  return ops;
};
