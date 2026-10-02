// Pure tree-building and flattening for the file panel (FileTree). Kept out of
// the component so it can be tested and so the renderer works from a flat row
// list of primitives it can memoize per row.
import { dirCountsFromFiles, DirCounts } from './fileTreeCounts';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  fileCount: number; // precomputed — no recursive counting at render time
  annotatedCount: number; // precomputed, alongside fileCount
  buzzdetectCount: number; // precomputed: files here with buzzdetect results
  nonMediaFiles?: string[]; // non-audio/video files directly in this dir
}

const toSlash = (p: string) => p.replace(/\\/g, '/');

/** Files strictly inside `dir`, accepting either separator on both sides. */
export function filterUnderDir(files: string[], dir: string): string[] {
  const prefix = toSlash(dir) + '/';
  return files.filter(f => toSlash(f).startsWith(prefix));
}

// Overwrite every dir node's counts with the unfiltered totals so the file-tree
// counts stay fixed regardless of the annotation / buzzdetect filters.
function applyDirCounts(node: TreeNode, counts: Map<string, DirCounts>): void {
  if (!node.isDir) return;
  const c = counts.get(node.path);
  node.fileCount = c?.total ?? 0;
  node.annotatedCount = c?.annotated ?? 0;
  node.buzzdetectCount = c?.buzzdetect ?? 0;
  for (const child of node.children) applyDirCounts(child, counts);
}

const newDir = (name: string, path: string): TreeNode =>
  ({ name, path, isDir: true, children: [], fileCount: 0, annotatedCount: 0, buzzdetectCount: 0 });

/**
 * `files` is what the tree shows (after filtering); `countFiles` is the whole
 * unfiltered list the per-folder counts are taken from.
 */
export function buildTree(
  rootDir: string,
  files: string[],
  nonMediaFiles: string[],
  annotatedTracks: Set<string>,
  buzzdetectTracks: Set<string>,
  countFiles: string[],
): TreeNode[] {
  const root = newDir('', rootDir);
  const dirMaps = new Map<TreeNode, Map<string, TreeNode>>();

  for (const file of files) {
    const parts = file.substring(rootDir.length + 1).split(/[\\/]/);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.children.push({ name: part, path: file, isDir: false, children: [], fileCount: 1, annotatedCount: 0, buzzdetectCount: 0 });
        break;
      }
      let dirMap = dirMaps.get(node);
      if (!dirMap) dirMaps.set(node, dirMap = new Map());
      let child = dirMap.get(part);
      if (!child) {
        child = newDir(part, rootDir + '/' + parts.slice(0, i + 1).join('/'));
        dirMap.set(part, child);
        node.children.push(child);
      }
      node = child;
    }
  }

  // Counts come from the unfiltered list, so they don't move when a filter is toggled.
  const counts = dirCountsFromFiles(rootDir, countFiles, annotatedTracks, buzzdetectTracks);
  for (const child of root.children) applyDirCounts(child, counts);

  if (nonMediaFiles.length > 0) {
    const nonMediaByDir = new Map<string, string[]>();
    for (const file of nonMediaFiles) {
      const parts = file.substring(rootDir.length + 1).split(/[\\/]/);
      if (parts.length <= 1) continue; // root-level, handled separately by the component
      const dirPath = rootDir + '/' + parts.slice(0, -1).join('/');
      const list = nonMediaByDir.get(dirPath);
      if (list) list.push(file);
      else nonMediaByDir.set(dirPath, [file]);
    }
    const attach = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (!n.isDir) continue;
        const nm = nonMediaByDir.get(n.path);
        if (nm) n.nonMediaFiles = nm;
        attach(n.children);
      }
    };
    attach(root.children);
  }

  return root.children;
}

export function getAllDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (!n.isDir) continue;
      paths.push(n.path);
      walk(n.children);
    }
  };
  walk(nodes);
  return paths;
}

/** Folder paths (as buildTree names them) between `root` and `track`. */
export function getAncestorPaths(track: string | null, root: string | null): Set<string> {
  const paths = new Set<string>();
  if (!track || !root) return paths;
  const parts = track.substring(root.length + 1).split(/[\\/]/);
  let path = root;
  for (let i = 0; i < parts.length - 1; i++) {
    path += '/' + parts[i];
    paths.add(path);
  }
  return paths;
}

/**
 * Expanded set after toggling `node`. Opening a folder that leads down an
 * unbranched chain (each holding exactly one subfolder) expands the whole
 * chain; closing collapses its whole subtree.
 */
export function toggleDirInSet(prev: Set<string>, node: TreeNode): Set<string> {
  const next = new Set(prev);
  if (next.has(node.path)) {
    const collapse = (n: TreeNode) => {
      next.delete(n.path);
      for (const child of n.children) if (child.isDir) collapse(child);
    };
    collapse(node);
  } else {
    let current: TreeNode | undefined = node;
    while (current) {
      next.add(current.path);
      const only: TreeNode | null = current.children.length === 1 ? current.children[0] : null;
      current = only?.isDir ? only : undefined;
    }
  }
  return next;
}

export type VisibleRow =
  | { kind: 'dir'; key: string; node: TreeNode; depth: number; parentPath: string; expanded: boolean }
  | { kind: 'file'; key: string; node: TreeNode; depth: number; parentPath: string }
  /** "N unsupported" disclosure under a folder (`depth` is the folder's; -1 for the root). */
  | { kind: 'nonMediaToggle'; key: string; path: string; count: number; depth: number; expanded: boolean }
  | { kind: 'nonMediaItem'; key: string; filePath: string; depth: number; crumb: string };

/** The rows currently on screen, in order, given what's expanded. */
export function flattenTree(
  tree: TreeNode[],
  rootPath: string,
  expandedDirs: Set<string>,
  expandedNonMedia: Set<string>,
  rootNonMedia: string[],
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const pushNonMedia = (path: string, files: string[], depth: number) => {
    const expanded = expandedNonMedia.has(path);
    rows.push({ kind: 'nonMediaToggle', key: `nm:${path}`, path, count: files.length, depth, expanded });
    if (expanded) for (const f of files) rows.push({ kind: 'nonMediaItem', key: `nmi:${f}`, filePath: f, depth, crumb: path });
  };
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const node of nodes) {
      if (!node.isDir) {
        rows.push({ kind: 'file', key: node.path, node, depth, parentPath });
        continue;
      }
      const expanded = expandedDirs.has(node.path);
      rows.push({ kind: 'dir', key: node.path, node, depth, parentPath, expanded });
      if (!expanded) continue;
      walk(node.children, depth + 1, node.path);
      if (node.nonMediaFiles?.length) pushNonMedia(node.path, node.nonMediaFiles, depth);
    }
  };
  walk(tree, 0, rootPath);
  if (rootNonMedia.length > 0) pushNonMedia(rootPath, rootNonMedia, -1);
  return rows;
}
