import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, ChevronLeft, ChevronsLeft, ArrowRight, Music, Film, FolderOpen, PanelLeft, EyeOff } from 'lucide-react';
import { FilePanelHeaderButtons } from './controls/FilePanelHeaderButtons';
import SidebarSection from './SidebarSection';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import { fileTree as copy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { parseFilenameTime } from '../utils/filenameTime';
import { previewDateTimeFormat, DateTimeFormat } from '../utils/datetimeDisplay';

export interface FilenameTimeInfo {
  pattern: string;
  offsetSeparator?: string;
  dateTimeFormat: DateTimeFormat;
}

/**
 * Filename tooltip, with a "(August 13, 1:00a)" second line when the name
 * matches the project's filename timestamp pattern. `displayText` is what the
 * tooltip shows (a bare name or a full path); the pattern is always matched
 * against just the basename, so a coincidental digit run in a parent
 * directory can't produce a bogus date.
 */
function tooltipWithDate(displayText: string, name: string, info: FilenameTimeInfo): string {
  const date = parseFilenameTime(name, info.pattern, info.offsetSeparator);
  return date ? `${displayText}\n(${previewDateTimeFormat(info.dateTimeFormat, date)})` : displayText;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  fileCount: number; // precomputed — no recursive counting at render time
  annotatedCount: number; // precomputed, alongside fileCount
  nonMediaFiles?: string[]; // non-audio/video files directly in this dir
}

interface FileTreeProps {
  rootDirectory: string | null;
  allFiles: string[];
  allFilesUnfiltered: string[];
  currentTrack: string | null;
  onFileSelect: (path: string) => void;
  /** Whole sidebar collapsed to its rail — FileTree renders only the reopen button. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** This section collapsed to its header within the sidebar's stack. */
  sectionCollapsed: boolean;
  onToggleSectionCollapsed: () => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  shuffleMode: boolean;
  onToggleShuffle: () => void;
  annotatedTracks: Set<string>;
  fileFilter: 'all' | 'annotated' | 'unannotated';
  onToggleFileFilter: () => void;
  onRevealInFinder: (path: string) => void;
  onRevealAnnotations: (audioFilePath: string) => void;
  onRevealAnnotationsRoot?: () => void;
  onImportAnnotations: (audioFilePath: string) => void;
  initialEnteredFolderPath?: string | null;
  onEnteredFolderChange?: (path: string | null) => void;
  nonMediaFiles?: string[];
  filenameTimeInfo: FilenameTimeInfo;
  /**
   * Reports the header state the guide's live copy of these buttons needs, plus
   * the one action (expand/collapse) whose state lives inside this component.
   * Called whenever `anyExpanded` flips.
   */
  onHeaderState?: (state: { anyExpanded: boolean; toggleExpandCollapse: () => void }) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  isAudioRoot?: boolean;
}

import { isSupportedMediaFile, SUPPORTED_AUDIO_EXTS, getExt } from '../constants';
import { stripExt, basename } from '../utils/helpers';

// OS-aware label for the system file browser
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('windows');
const finderLabel = isWindows ? 'File Explorer' : 'Finder';

function computeFileCount(node: TreeNode, annotatedTracks: Set<string>): [number, number] {
  if (!node.isDir) {
    node.annotatedCount = annotatedTracks.has(node.path) ? 1 : 0;
    return [1, node.annotatedCount];
  }
  let count = 0;
  let annotated = 0;
  for (const c of node.children) {
    const [cCount, cAnnotated] = computeFileCount(c, annotatedTracks);
    count += cCount;
    annotated += cAnnotated;
  }
  node.fileCount = count;
  node.annotatedCount = annotated;
  return [count, annotated];
}

// Directory (annotated, total) counts derived from a flat file list, keyed by
// the same `/`-joined dir paths buildTree assigns to its nodes.
function dirCountsFromFiles(
  rootDir: string,
  files: string[],
  annotatedTracks: Set<string>,
): Map<string, [number, number]> {
  const counts = new Map<string, [number, number]>();
  for (const file of files) {
    if (!file.startsWith(rootDir + '/') && !file.startsWith(rootDir + '\\')) continue;
    const rel = file.substring(rootDir.length + 1);
    const parts = rel.split(/[\\/]/);
    const isAnnotated = annotatedTracks.has(file) ? 1 : 0;
    let path = rootDir;
    for (let i = 0; i < parts.length - 1; i++) {
      path += '/' + parts[i];
      const cur = counts.get(path) ?? [0, 0];
      cur[0] += 1;
      cur[1] += isAnnotated;
      counts.set(path, cur);
    }
  }
  return counts;
}

// Overwrite every dir node's counts with the unfiltered totals so the file-tree
// counts stay fixed regardless of the annotated/unannotated filter.
function applyDirCounts(node: TreeNode, counts: Map<string, [number, number]>): void {
  if (!node.isDir) return;
  const [total, annotated] = counts.get(node.path) ?? [0, 0];
  node.fileCount = total;
  node.annotatedCount = annotated;
  for (const c of node.children) applyDirCounts(c, counts);
}

function buildTree(
  rootDir: string,
  files: string[],
  nonMediaFiles: string[] = [],
  annotatedTracks: Set<string> = new Set(),
  countFiles?: string[],
): TreeNode[] {
  const root: TreeNode = { name: '', path: rootDir, isDir: true, children: [], fileCount: 0, annotatedCount: 0 };

  for (const file of files) {
    const rel = file.substring(rootDir.length + 1);
    const parts = rel.split(/[\\/]/);

    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        node.children.push({ name: part, path: file, isDir: false, children: [], fileCount: 1, annotatedCount: 0 });
      } else {
        // Use a Map stored on the node for O(1) child lookups during tree building
        if (!(node as any)._dirMap) (node as any)._dirMap = new Map<string, TreeNode>();
        const dirMap = (node as any)._dirMap as Map<string, TreeNode>;
        let child = dirMap.get(part);
        if (!child) {
          const dirPath = rootDir + '/' + parts.slice(0, i + 1).join('/');
          child = { name: part, path: dirPath, isDir: true, children: [], fileCount: 0, annotatedCount: 0 };
          dirMap.set(part, child);
          node.children.push(child);
        }
        node = child;
      }
    }
  }

  // Precompute file + annotated counts bottom-up
  for (const child of root.children) computeFileCount(child, annotatedTracks);

  // When a filter is active, `files` is the filtered subset but the displayed
  // counts should still reflect the whole project — recompute dir counts from
  // the unfiltered list.
  if (countFiles) {
    const counts = dirCountsFromFiles(rootDir, countFiles, annotatedTracks);
    for (const child of root.children) applyDirCounts(child, counts);
  }

  // Attach non-media files to their containing directory nodes
  if (nonMediaFiles.length > 0) {
    const nonMediaByDir = new Map<string, string[]>();
    for (const file of nonMediaFiles) {
      const rel = file.substring(rootDir.length + 1);
      const parts = rel.split(/[\\/]/);
      if (parts.length <= 1) continue; // root-level, handled separately by component
      const dirPath = rootDir + '/' + parts.slice(0, -1).join('/');
      if (!nonMediaByDir.has(dirPath)) nonMediaByDir.set(dirPath, []);
      nonMediaByDir.get(dirPath)!.push(file);
    }
    const attachNonMedia = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.isDir) {
          const nm = nonMediaByDir.get(n.path);
          if (nm) n.nonMediaFiles = nm;
          attachNonMedia(n.children);
        }
      }
    };
    attachNonMedia(root.children);
  }

  return root.children;
}

// ── Pinned breadcrumb ───────────────────────────────────────────────────────
// One row pinned to the top of the scroll view naming the folders the topmost
// visible row lives in, so you always know where you are in a deep tree. Only
// worth the row if enough tracks still fit below it.
const DEFAULT_ROW_H = 24;
const MIN_VISIBLE_TRACKS = 3;

/** Is the panel tall enough to give up a row to the breadcrumb? */
function fitsBreadcrumb(clientHeight: number, rowH: number): boolean {
  return rowH > 0 && clientHeight >= (MIN_VISIBLE_TRACKS + 1) * rowH;
}

function getAllDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      paths.push(node.path);
      paths.push(...getAllDirPaths(node.children));
    }
  }
  return paths;
}

function getAncestorPaths(currentTrack: string | null, rootDirectory: string | null): Set<string> {
  const paths = new Set<string>();
  if (!currentTrack || !rootDirectory) return paths;
  const rel = currentTrack.substring(rootDirectory.length + 1);
  const parts = rel.split(/[\\/]/);
  let path = rootDirectory;
  for (let i = 0; i < parts.length - 1; i++) {
    path += '/' + parts[i];
    paths.add(path);
  }
  return paths;
}

interface TreeItemProps {
  node: TreeNode;
  currentTrack: string | null;
  onFileSelect: (path: string) => void;
  depth: number;
  expandedDirs: Set<string>;
  toggleDir: (node: TreeNode) => void;
  annotatedTracks: Set<string>;
  ancestorPaths: Set<string>;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onEnterFolder: (path: string) => void;
  expandedNonMedia: Set<string>;
  toggleNonMedia: (path: string) => void;
  /** Folder this node sits in — rows report it to the pinned breadcrumb. */
  parentPath: string;
  filenameTimeInfo: FilenameTimeInfo;
}

const TreeItem: React.FC<TreeItemProps> = ({
  node,
  currentTrack,
  onFileSelect,
  depth,
  expandedDirs,
  toggleDir,
  annotatedTracks,
  ancestorPaths,
  onContextMenu,
  onEnterFolder,
  expandedNonMedia,
  toggleNonMedia,
  parentPath,
  filenameTimeInfo,
}) => {
  if (node.isDir) {
    const isExpanded = expandedDirs.has(node.path);
    const isClosedAncestor = !isExpanded && ancestorPaths.has(node.path);
    return (
      <div>
        <div
          className={`relative group flex items-center w-full transition-colors ${
            isClosedAncestor
              ? 'bg-[#e65161]/10 hover:bg-[#e65161]/20 text-[#e65161]'
              : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
          data-folder-path={node.path}
          // The breadcrumb covers this row when it reaches the top edge, so an
          // expanded folder stands in for itself there — that's what makes the
          // crumb grow a level as you scroll into a folder rather than all at
          // once when its files arrive. A collapsed folder isn't context.
          data-crumb={isExpanded ? node.path : parentPath}
        >
          <button
            onClick={() => toggleDir(node)}
            className="flex items-center gap-1 flex-1 min-w-0 px-2 py-1 text-left"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {isExpanded
              ? <ChevronDown size={12} className="flex-none opacity-60" />
              : <ChevronRight size={12} className="flex-none opacity-60" />
            }
            <FolderOpen size={13} className={`flex-none ${isClosedAncestor ? 'text-[#e65161]/70' : 'text-slate-500 group-hover:text-slate-300'}`} />
            <span className="text-xs truncate">{node.name}</span>
            <span className={`text-[10px] ml-auto flex-none pr-1 ${isClosedAncestor ? 'text-[#e65161]/50' : 'text-slate-600'}`}>
              {node.annotatedCount}/{node.fileCount}
            </span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onEnterFolder(node.path); }}
            className="absolute inset-y-0 right-1 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
            data-tooltip={`Enter ${node.name}`}
            tabIndex={-1}
          >
            <span className="flex items-center justify-center w-4 h-4 rounded bg-slate-700 shadow-md text-slate-300 hover:text-white hover:bg-slate-600">
              <ArrowRight size={10} />
            </span>
          </button>
        </div>
        {isExpanded && node.children.map(child => (
          <TreeItem
            key={child.path}
            node={child}
            currentTrack={currentTrack}
            onFileSelect={onFileSelect}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
            annotatedTracks={annotatedTracks}
            ancestorPaths={ancestorPaths}
            onContextMenu={onContextMenu}
            onEnterFolder={onEnterFolder}
            expandedNonMedia={expandedNonMedia}
            toggleNonMedia={toggleNonMedia}
            parentPath={node.path}
            filenameTimeInfo={filenameTimeInfo}
          />
        ))}
        {isExpanded && node.nonMediaFiles && node.nonMediaFiles.length > 0 && (
          <div>
            <button
              className="flex items-center gap-1 w-full text-left text-slate-600 hover:text-slate-500 py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px`, paddingRight: '8px' }}
              onClick={() => toggleNonMedia(node.path)}
              data-crumb={node.path}
            >
              <span className="text-[9px] uppercase tracking-wider opacity-50 select-none">
                {expandedNonMedia.has(node.path) ? '▾' : '▸'} {node.nonMediaFiles.length} unsupported
              </span>
            </button>
            {expandedNonMedia.has(node.path) && node.nonMediaFiles.map(filePath => {
              const fname = filePath.split(/[\\/]/).pop() ?? filePath;
              return (
                <div
                  key={filePath}
                  className="flex items-center w-full py-px text-slate-600 opacity-40 select-none"
                  style={{ paddingLeft: `${(depth + 1) * 12 + 22}px`, paddingRight: '8px' }}
                  data-tooltip={fname}
                  data-crumb={node.path}
                >
                  <span className="text-[10px] truncate flex-1 italic">{fname}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const isActive = node.path === currentTrack;
  const isAudio = SUPPORTED_AUDIO_EXTS.has(getExt(node.name));
  const hasAnnotation = annotatedTracks.has(node.path);
  const isSupported = isSupportedMediaFile(node.path);

  if (!isSupported) {
    return (
      <div
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, false); }}
        className="flex items-center gap-2 w-full py-1 text-left text-slate-600 cursor-not-allowed"
        style={{ paddingLeft: `${depth * 12 + 22}px`, paddingRight: '8px' }}
        data-tooltip={`${node.name} (unsupported file type)`}
        data-crumb={parentPath}
      >
        {isAudio
          ? <Music size={12} className="flex-none opacity-40" />
          : <Film size={12} className="flex-none opacity-40" />
        }
        <span className="text-xs truncate flex-1 italic">{node.name}</span>
        <span className="text-[10px] flex-none opacity-70">{copy.unsupported}</span>
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileSelect(node.path)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, false); }}
      className={`flex items-center gap-2 w-full py-1 text-left transition-colors ${
        isActive
          ? `bg-[#e65161]/20 ${hasAnnotation ? 'text-white' : 'text-[#e65161]'}`
          : hasAnnotation
            ? 'hover:bg-slate-800 text-sky-600 hover:text-sky-500'
            : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'
      }`}
      style={{ paddingLeft: `${depth * 12 + 22}px`, paddingRight: '8px' }}
      data-tooltip={tooltipWithDate(node.name, node.name, filenameTimeInfo)}
      data-active-file={isActive ? '' : undefined}
      data-crumb={parentPath}
    >
      {isAudio
        ? <Music size={12} className="flex-none opacity-70" />
        : <Film size={12} className="flex-none opacity-70" />
      }
      <span className="text-xs truncate flex-1">{node.name}</span>
    </button>
  );
};

function FileTree({
  rootDirectory,
  allFiles,
  allFilesUnfiltered,
  currentTrack,
  onFileSelect,
  collapsed,
  onToggleCollapse,
  sectionCollapsed,
  onToggleSectionCollapsed,
  onNavigatePrev,
  onNavigateNext,
  canNavigatePrev,
  canNavigateNext,
  shuffleMode,
  onToggleShuffle,
  annotatedTracks,
  fileFilter,
  onToggleFileFilter,
  onRevealInFinder,
  onRevealAnnotations,
  onRevealAnnotationsRoot,
  onImportAnnotations,
  initialEnteredFolderPath,
  onEnteredFolderChange,
  nonMediaFiles,
  filenameTimeInfo,
  onHeaderState,
}: FileTreeProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [enteredPath, setEnteredPath] = useState<string | null>(initialEnteredFolderPath ?? null);
  const scrollToFolderRef = useRef<string | null>(null);
  const [expandedNonMedia, setExpandedNonMedia] = useState<Set<string>>(new Set());

  // Reset enter state when the media root changes
  useEffect(() => {
    setEnteredPath(initialEnteredFolderPath ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDirectory]);

  const enterFolder = useCallback((folderPath: string) => {
    setEnteredPath(folderPath);
    setExpandedDirs(new Set());
    onEnteredFolderChange?.(folderPath);
  }, [onEnteredFolderChange]);

  // Step up one folder. If the parent is the media root (or above), return to root.
  const goUpOne = useCallback(() => {
    if (!enteredPath || !rootDirectory) return;
    const exiting = enteredPath;
    const sep = enteredPath.includes('\\') ? '\\' : '/';
    const idx = enteredPath.lastIndexOf(sep);
    const parent = idx > 0 ? enteredPath.slice(0, idx) : '';
    // Stay inside the media root; otherwise fall back to the full root view.
    const next = parent.length > rootDirectory.length && parent.startsWith(rootDirectory) ? parent : null;
    setEnteredPath(next);
    onEnteredFolderChange?.(next);
    // Reveal the folder we just stepped out of (now a child of the new view).
    setExpandedDirs(new Set([exiting]));
    scrollToFolderRef.current = exiting;
  }, [enteredPath, rootDirectory, onEnteredFolderChange]);

  // Jump straight back to the media root.
  const goToRoot = useCallback(() => {
    setEnteredPath(null);
    setExpandedDirs(new Set());
    onEnteredFolderChange?.(null);
  }, [onEnteredFolderChange]);

  const effectiveRoot = enteredPath ?? rootDirectory;
  const effectiveFiles = useMemo(() => {
    if (!enteredPath) return allFiles;
    // Windows paths use `\`; accept either separator so the prefix check works
    // regardless of which the OS returned.
    const prefix = enteredPath.replace(/\\/g, '/') + '/';
    return allFiles.filter(f => f.replace(/\\/g, '/').startsWith(prefix));
  }, [enteredPath, allFiles]);

  const effectiveTotalFiles = useMemo(() => {
    if (!enteredPath) return allFilesUnfiltered;
    const prefix = enteredPath.replace(/\\/g, '/') + '/';
    return allFilesUnfiltered.filter(f => f.replace(/\\/g, '/').startsWith(prefix));
  }, [enteredPath, allFilesUnfiltered]);

  const effectiveNonMediaFiles = useMemo(() => {
    if (!nonMediaFiles || !effectiveRoot) return [];
    if (!enteredPath) return nonMediaFiles;
    const prefix = enteredPath.replace(/\\/g, '/') + '/';
    return nonMediaFiles.filter(f => f.replace(/\\/g, '/').startsWith(prefix));
  }, [enteredPath, nonMediaFiles, effectiveRoot]);

  const rootNonMedia = useMemo(() => {
    if (!effectiveRoot) return [];
    const rootNorm = effectiveRoot.replace(/\\/g, '/');
    return effectiveNonMediaFiles.filter(f => {
      const rel = f.replace(/\\/g, '/').substring(rootNorm.length + 1);
      return rel.length > 0 && !rel.includes('/');
    });
  }, [effectiveNonMediaFiles, effectiveRoot]);

  const toggleNonMedia = useCallback((path: string) => {
    setExpandedNonMedia(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const tree = useMemo(() => {
    if (!effectiveRoot) return [];
    if (effectiveFiles.length === 0 && effectiveNonMediaFiles.length === 0) return [];
    return buildTree(effectiveRoot, effectiveFiles, effectiveNonMediaFiles, annotatedTracks, effectiveTotalFiles);
  }, [effectiveRoot, effectiveFiles, effectiveNonMediaFiles, annotatedTracks, effectiveTotalFiles]);

  // Header count for the entered dir — the whole (unfiltered) project total, so
  // it doesn't move when the annotated/unannotated filter is toggled.
  const rootCounts = useMemo(() => {
    let annotatedCount = 0;
    for (const f of effectiveTotalFiles) if (annotatedTracks.has(f)) annotatedCount += 1;
    return { fileCount: effectiveTotalFiles.length, annotatedCount };
  }, [effectiveTotalFiles, annotatedTracks]);

  // Preserve scroll position across tree rebuilds (refresh, file-list changes,
  // opening a folder's contents) as long as we're still viewing the same folder.
  // Only a genuine folder change (enter / step up / root change) resets to top.
  const prevRootRef = useRef(effectiveRoot);
  const lastScrollTopRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    const sameRoot = prevRootRef.current === effectiveRoot;
    prevRootRef.current = effectiveRoot;
    if (!el) return;
    // A genuine folder change (enter / step up / root change) starts at the top;
    // `goUpOne` then scrolls from there to the folder it stepped out of.
    el.scrollTop = sameRoot ? lastScrollTopRef.current : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  // Also auto-expand ancestors of the current file
  useEffect(() => {
    if (!currentTrack || !effectiveRoot) return;
    const rel = currentTrack.substring(effectiveRoot.length + 1);
    const parts = rel.split(/[\\/]/);
    setExpandedDirs(prev => {
      const next = new Set(prev);
      let path = effectiveRoot;
      for (let i = 0; i < parts.length - 1; i++) {
        path += '/' + parts[i];
        next.add(path);
      }
      return next;
    });
  }, [currentTrack, effectiveRoot]);

  // Opening a folder that leads down an unbranched chain (each folder holding
  // exactly one subfolder) expands the whole chain at once, so the user isn't
  // stuck clicking through folders that offer no actual choice.
  const toggleDir = (node: TreeNode) => {
    cancelPendingActiveScroll();
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        const collapseSubtree = (n: TreeNode) => {
          next.delete(n.path);
          for (const child of n.children) if (child.isDir) collapseSubtree(child);
        };
        collapseSubtree(node);
      } else {
        let current: TreeNode | undefined = node;
        while (current) {
          next.add(current.path);
          const onlyChild = current.children.length === 1 ? current.children[0] : null;
          current = onlyChild?.isDir ? onlyChild : undefined;
        }
      }
      return next;
    });
  };

  const expandAll = () => {
    cancelPendingActiveScroll();
    setExpandedDirs(new Set(getAllDirPaths(tree)));
  };

  const collapseAll = () => {
    // Collapse everything — ancestor dirs of the active file are highlighted
    // rather than auto-expanded, so the user still knows where it lives.
    cancelPendingActiveScroll();
    setExpandedDirs(new Set());
  };

  const isAnyExpanded = expandedDirs.size > 0;

  // ── Custom scrollbar ──────────────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const [activeItemFraction, setActiveItemFraction] = useState<number | null>(null);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_H);
  // Folder path the pinned breadcrumb names.
  const [crumbPath, setCrumbPath] = useState<string | null>(null);
  const activeItemFractionRef = useRef<number | null>(null);
  const isDraggingThumb = useRef(false);
  const thumbDragStartY = useRef(0);
  const thumbDragStartScrollTop = useRef(0);

  useEffect(() => { activeItemFractionRef.current = activeItemFraction; }, [activeItemFraction]);

  const syncScrollbar = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    lastScrollTopRef.current = el.scrollTop;
    setScrollState({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    const activeEl = el.querySelector('[data-active-file]') as HTMLElement | null;
    if (activeEl && el.scrollHeight > 0) {
      const containerRect = el.getBoundingClientRect();
      const elRect = activeEl.getBoundingClientRect();
      const relTop = elRect.top - containerRect.top + el.scrollTop;
      const frac = (relTop + elRect.height / 2) / el.scrollHeight;
      setActiveItemFraction(Math.max(0, Math.min(1, frac)));
    } else {
      setActiveItemFraction(null);
    }

    // The breadcrumb names the context of whichever row sits at the top edge —
    // one hit-test, rather than a rect read per folder in the tree. Each row
    // reports that context itself (see `data-crumb`), so the crumb deepens a
    // level each time a folder header scrolls under it.
    const firstFolder = el.querySelector('[data-folder-path]') as HTMLElement | null;
    const rowH = firstFolder?.offsetHeight || DEFAULT_ROW_H;
    setRowHeight(prev => (prev === rowH ? prev : rowH));

    let path: string | null = null;
    const rect = el.getBoundingClientRect();
    if (el.scrollTop > 0 && fitsBreadcrumb(rect.height, rowH)) {
      const hit = (document.elementFromPoint(rect.left + 12, rect.top + 1) as HTMLElement | null)
        ?.closest('[data-crumb]') as HTMLElement | null;
      if (hit) path = hit.dataset.crumb ?? null;
    }
    setCrumbPath(prev => (prev === path ? prev : path));
  }, []);

  // When the active track changes, nudge the scroll so the item is visible:
  // - if it's above the viewport, make it the first visible row
  // - if it's below the viewport, make it the last visible row
  //
  // The row may not be in the DOM on the render where `currentTrack` changes —
  // the ancestor-expanding effect above is a plain effect, so it reveals the row
  // a render later. The request is therefore held in a ref and consumed on
  // whichever render first paints the row. `expandedDirs` is in the deps purely
  // to get that retry; expanding or collapsing a folder on its own must never
  // move the view, so user-driven toggles drop the pending request first.
  const pendingActiveScrollRef = useRef(true);
  const scrolledForTrackRef = useRef<string | null>(null);
  const cancelPendingActiveScroll = useCallback(() => {
    pendingActiveScrollRef.current = false;
  }, []);
  useLayoutEffect(() => {
    if (scrolledForTrackRef.current !== currentTrack) {
      scrolledForTrackRef.current = currentTrack;
      pendingActiveScrollRef.current = true;
    }
    if (!pendingActiveScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const activeEl = el.querySelector('[data-active-file]') as HTMLElement | null;
    if (!activeEl) return; // stays pending until the row exists
    pendingActiveScrollRef.current = false;
    const containerRect = el.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    const topRelative = elRect.top - containerRect.top;
    const bottomRelative = elRect.bottom - containerRect.top;
    if (topRelative < 0) {
      el.scrollTop += topRelative;
    } else if (bottomRelative > el.clientHeight) {
      el.scrollTop += bottomRelative - el.clientHeight;
    }
  }, [currentTrack, expandedDirs]);

  useLayoutEffect(syncScrollbar, [currentTrack, allFiles, expandedDirs, shuffleMode, syncScrollbar]);

  useLayoutEffect(() => {
    const path = scrollToFolderRef.current;
    if (!path) return;
    scrollToFolderRef.current = null;
    const el = scrollContainerRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-folder-path="${CSS.escape(path)}"]`) as HTMLElement | null;
    if (!target) return;
    const containerRect = el.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    el.scrollTop += targetRect.top - containerRect.top;
  }, [expandedDirs]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(syncScrollbar);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncScrollbar]);

  const { scrollTop, scrollHeight, clientHeight } = scrollState;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const showScrollbar = scrollHeight > clientHeight + 2;
  const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * clientHeight);
  const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * (clientHeight - thumbHeight) : 0;
  const SNAP_THRESHOLD = 50;

  const handleThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingThumb.current = true;
    thumbDragStartY.current = e.clientY;
    thumbDragStartScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0;

    const onMouseMove = (ev: MouseEvent) => {
      const container = scrollContainerRef.current;
      if (!isDraggingThumb.current || !container) return;
      const { scrollHeight: sh, clientHeight: ch } = container;
      const maxST = Math.max(0, sh - ch);
      const thumbH = Math.max(20, (ch / sh) * ch);
      const trackH = ch - thumbH;
      if (trackH <= 0) return;
      let newScrollTop = thumbDragStartScrollTop.current + ((ev.clientY - thumbDragStartY.current) / trackH) * maxST;
      const frac = activeItemFractionRef.current;
      if (frac !== null) {
        const snapST = Math.max(0, Math.min(frac * sh - ch / 2, maxST));
        if (Math.abs(newScrollTop - snapST) < SNAP_THRESHOLD) newScrollTop = snapST;
      }
      container.scrollTop = Math.max(0, Math.min(newScrollTop, maxST));
    };

    const onMouseUp = () => {
      isDraggingThumb.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTrackMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const track = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientY - track.top) / track.height;
    container.scrollTop = frac * (container.scrollHeight - container.clientHeight);
  };
  // ─────────────────────────────────────────────────────────────────────────

  const toggleExpandCollapse = () => {
    if (isAnyExpanded) collapseAll();
    else expandAll();
  };

  // Publish the header state upward for the guide's live copy of these buttons.
  // The callback closes over the current isAnyExpanded, so it is re-sent
  // whenever that flips rather than held as a stale closure.
  useEffect(() => {
    onHeaderState?.({ anyExpanded: isAnyExpanded, toggleExpandCollapse });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnyExpanded]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, []);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    if (!rootDirectory) return;
    e.preventDefault();
    if (enteredPath) {
      setContextMenu({ x: e.clientX, y: e.clientY, path: enteredPath, isDir: true });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, path: rootDirectory, isDir: true, isAudioRoot: true });
    }
  }, [rootDirectory, enteredPath]);

  const dirName = enteredPath ? basename(enteredPath) : (rootDirectory ? basename(rootDirectory) : 'No folder');

  // Folder names between the panel root and the row under the breadcrumb.
  const crumbs = useMemo(() => {
    if (!crumbPath || !effectiveRoot || !crumbPath.startsWith(effectiveRoot)) return [];
    return crumbPath.substring(effectiveRoot.length + 1).split(/[\\/]/).filter(Boolean);
  }, [crumbPath, effectiveRoot]);

  const menuItems = (m: ContextMenuState): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: `Show media in ${finderLabel}`, onSelect: () => onRevealInFinder(m.path) },
    ];
    if (rootDirectory && m.path !== rootDirectory &&
        ((!m.isDir && isSupportedMediaFile(m.path)) || (m.isDir && !m.isAudioRoot))) {
      items.push({
        label: copy.copyIdent,
        onSelect: () => {
          // Ident = path relative to the audio root, '/'-separated. Files drop
          // their extension; folders keep their full relative path.
          const rel = m.path.substring(rootDirectory.length + 1).replace(/\\/g, '/');
          navigator.clipboard.writeText(m.isDir ? rel : stripExt(rel));
        },
      });
    }
    if (!m.isDir && isSupportedMediaFile(m.path)) {
      items.push({ label: copy.importAnnotations, onSelect: () => onImportAnnotations(m.path) });
    }
    const showsAnnotations = (!m.isDir && annotatedTracks.has(m.path)) || (m.isDir && !m.isAudioRoot);
    if (showsAnnotations) {
      items.push({ label: `Show Annotations in ${finderLabel}`, onSelect: () => onRevealAnnotations(m.path) });
    } else if (m.isAudioRoot && onRevealAnnotationsRoot) {
      items.push({ label: `Show Annotations in ${finderLabel}`, onSelect: onRevealAnnotationsRoot });
    }
    return items;
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center pt-2 gap-2 flex-none">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          data-tooltip={tooltips.showFileTree}
        >
          <PanelLeft size={16} />
        </button>
      </div>
    );
  }

  return (
    <SidebarSection
      collapsed={sectionCollapsed}
      onToggleCollapsed={onToggleSectionCollapsed}
      onHeaderContextMenu={handleRootContextMenu}
      title={(
        <>
          {enteredPath && (
            <>
              <button
                onClick={goToRoot}
                className="p-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white flex-none"
                data-tooltip={tooltips.backToRoot}
              >
                <ChevronsLeft size={13} />
              </button>
              <button
                onClick={goUpOne}
                className="p-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white flex-none"
                data-tooltip={tooltips.upOneFolder}
              >
                <ChevronLeft size={13} />
              </button>
            </>
          )}
          <FolderOpen size={13} className="flex-none text-slate-500" />
          <span className="text-xs text-slate-400 truncate" data-tooltip={effectiveRoot || ''}>
            {dirName}
          </span>
          <span className="text-[10px] text-slate-600 flex-none">
            ({rootCounts.annotatedCount}/{rootCounts.fileCount})
          </span>
        </>
      )}
      actions={(
        <FilePanelHeaderButtons
          shuffleMode={shuffleMode}
          anyExpanded={isAnyExpanded}
          fileFilter={fileFilter}
          onToggleExpandCollapse={toggleExpandCollapse}
          onToggleFileFilter={onToggleFileFilter}
          onToggleShuffle={onToggleShuffle}
        />
      )}
    >
      {/* File list — inner flex row keeps the scrollbar track a true sibling, not an overlay */}
      <div className="relative flex-1 min-h-0 flex overflow-hidden bg-slate-900 select-none">
        {/* Pinned breadcrumb — the folders the row beneath it lives in. Must stay
            pointer-transparent: the hit-test that drives it probes through here. */}
        {crumbs.length > 0 && (
          <div
            className="absolute left-0 right-2 top-0 z-30 flex items-center gap-1 px-2 bg-slate-900 border-b border-slate-700 pointer-events-none overflow-hidden"
            style={{ height: `${rowHeight}px`, boxShadow: '0 3px 5px -2px rgba(0,0,0,0.6)' }}
          >
            <FolderOpen size={13} className="flex-none text-slate-500" />
            {crumbs.map((name, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-[10px] text-slate-600 flex-none">/</span>}
                <span
                  // Parents shrink first so the folder you're actually in stays legible
                  className={`text-xs truncate ${i === crumbs.length - 1 ? 'text-slate-300 flex-none max-w-full' : 'text-slate-500 min-w-0'}`}
                >
                  {name}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}
        <div
          ref={scrollContainerRef}
          className="flex-1 min-w-0 overflow-y-scroll no-scrollbar"
          onScroll={syncScrollbar}
        >
        {!rootDirectory && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <FolderOpen size={28} className="mb-2 opacity-50" />
            <p className="text-xs">{copy.emptyHint}</p>
          </div>
        )}

        {rootDirectory && effectiveTotalFiles.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <Music size={28} className="mb-2 opacity-50" />
            <p className="text-sm">{copy.noMediaFiles}</p>
          </div>
        )}

        {rootDirectory && effectiveTotalFiles.length > 0 && effectiveFiles.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <EyeOff size={28} className="mb-2 opacity-50" />
            <p className="text-sm">{copy.noFilesMatchFilter(fileFilter as 'annotated' | 'unannotated')}</p>
          </div>
        )}

        {/* Shuffle mode: windowed flat list (±105 files around current, fade at edges only when files are hidden there) */}
        {shuffleMode && rootDirectory && effectiveFiles.length > 0 && (() => {
          const WINDOW = 105;
          const FADE_ZONE = 5; // items at each edge that fade, but only when files are hidden on that side

          const currentIdx = allFiles.findIndex(f => f === currentTrack);
          const startIdx = Math.max(0, currentIdx >= 0 ? currentIdx - WINDOW : 0);
          const endIdx = Math.min(allFiles.length - 1, currentIdx >= 0 ? currentIdx + WINDOW : WINDOW * 2);
          const visible = allFiles.slice(startIdx, endIdx + 1);
          const hasMoreBefore = startIdx > 0;
          const hasMoreAfter = endIdx < allFiles.length - 1;

          return (
            <>
              {hasMoreBefore && (
                <div className="px-3 py-1 text-[10px] text-slate-600 italic select-none">
                  ⋯ {startIdx} file{startIdx !== 1 ? 's' : ''} not shown
                </div>
              )}
              {visible.map((filePath, i) => {
                const absoluteIdx = startIdx + i;
                const distFromTop = absoluteIdx - startIdx;
                const distFromBottom = endIdx - absoluteIdx;
                let opacity = 1;
                if (hasMoreBefore && distFromTop < FADE_ZONE) {
                  opacity = Math.min(opacity, (distFromTop + 1) / (FADE_ZONE + 1));
                }
                if (hasMoreAfter && distFromBottom < FADE_ZONE) {
                  opacity = Math.min(opacity, (distFromBottom + 1) / (FADE_ZONE + 1));
                }

                const rel = filePath.substring(rootDirectory.length + 1);
                const relNoExt = stripExt(rel);
                const isActive = filePath === currentTrack;
                const isAudio = SUPPORTED_AUDIO_EXTS.has(getExt(filePath));
                const hasAnnotation = annotatedTracks.has(filePath);
                const isSupported = isSupportedMediaFile(filePath);
                if (!isSupported) {
                  return (
                    <div
                      key={filePath}
                      onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, filePath, false); }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-slate-600 cursor-not-allowed"
                      style={{ opacity }}
                      data-tooltip={`${filePath} (unsupported file type)`}
                    >
                      {isAudio
                        ? <Music size={12} className="flex-none opacity-40" />
                        : <Film size={12} className="flex-none opacity-40" />
                      }
                      <span className="text-xs truncate flex-1 italic">{relNoExt}</span>
                      <span className="text-[10px] flex-none opacity-70">{copy.unsupported}</span>
                    </div>
                  );
                }
                return (
                  <button
                    key={filePath}
                    onClick={() => onFileSelect(filePath)}
                    onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, filePath, false); }}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                      isActive
                        ? `bg-[#e65161]/20 ${hasAnnotation ? 'text-white' : 'text-[#e65161]'}`
                        : hasAnnotation
                          ? 'hover:bg-slate-800 text-sky-600 hover:text-sky-500'
                          : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'
                    }`}
                    style={{ opacity }}
                    data-tooltip={tooltipWithDate(filePath, basename(filePath), filenameTimeInfo)}
                    data-active-file={isActive ? '' : undefined}
                  >
                    {isAudio
                      ? <Music size={12} className="flex-none opacity-70" />
                      : <Film size={12} className="flex-none opacity-70" />
                    }
                    <span className="text-xs truncate flex-1">{relNoExt}</span>
                  </button>
                );
              })}
              {hasMoreAfter && (
                <div className="px-3 py-1 text-[10px] text-slate-600 italic select-none">
                  ⋯ {allFiles.length - 1 - endIdx} file{allFiles.length - 1 - endIdx !== 1 ? 's' : ''} not shown
                </div>
              )}
            </>
          );
        })()}

        {/* Normal tree mode */}
        {!shuffleMode && (() => {
          const ancestorPaths = getAncestorPaths(currentTrack, effectiveRoot);
          return (
            <>
              {tree.map(node => (
                <TreeItem
                  key={node.path}
                  node={node}
                  currentTrack={currentTrack}
                  onFileSelect={onFileSelect}
                  depth={0}
                  expandedDirs={expandedDirs}
                  toggleDir={toggleDir}
                  annotatedTracks={annotatedTracks}
                  ancestorPaths={ancestorPaths}
                  onContextMenu={handleContextMenu}
                  onEnterFolder={enterFolder}
                  expandedNonMedia={expandedNonMedia}
                  toggleNonMedia={toggleNonMedia}
                  parentPath={effectiveRoot ?? ''}
                  filenameTimeInfo={filenameTimeInfo}
                />
              ))}
              {rootNonMedia.length > 0 && (
                <div>
                  <button
                    className="flex items-center gap-1 w-full text-left text-slate-600 hover:text-slate-500 py-0.5 px-2"
                    onClick={() => toggleNonMedia(effectiveRoot ?? '')}
                  >
                    <span className="text-[9px] uppercase tracking-wider opacity-50 select-none">
                      {expandedNonMedia.has(effectiveRoot ?? '') ? '▾' : '▸'} {rootNonMedia.length} unsupported
                    </span>
                  </button>
                  {expandedNonMedia.has(effectiveRoot ?? '') && rootNonMedia.map(filePath => {
                    const fname = filePath.split(/[\\/]/).pop() ?? filePath;
                    return (
                      <div
                        key={filePath}
                        className="flex items-center w-full py-px pl-[22px] pr-2 text-slate-600 opacity-40 select-none"
                        data-tooltip={fname}
                        data-crumb={effectiveRoot ?? ''}
                      >
                        <span className="text-[10px] truncate flex-1 italic">{fname}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
        </div>{/* end scroll container */}

        {/* Scrollbar track — always present so content is always bounded by it */}
        <div
          className="w-2 flex-none bg-[#1F2937] relative cursor-ns-resize"
          onMouseDown={handleTrackMouseDown}
        >
          {showScrollbar && (
            <>
              {/* Hash below thumb */}
              {activeItemFraction !== null && (
                <div
                  className="absolute inset-x-0 pointer-events-none rounded-sm"
                  style={{ top: `${activeItemFraction * 100}%`, height: '3px', background: '#e65161', transform: 'translateY(-50%)' }}
                />
              )}
              {/* Thumb on top, semi-transparent so hash shows through */}
              <div
                className="absolute inset-x-0 rounded-full bg-slate-600/60 hover:bg-slate-500/70 transition-colors cursor-ns-resize"
                style={{ top: `${thumbTop}px`, height: `${thumbHeight}px` }}
                onMouseDown={handleThumbMouseDown}
              />
            </>
          )}
        </div>
      </div>

      {fileFilter !== 'all' && rootDirectory && effectiveFiles.length < effectiveTotalFiles.length && (
        <div className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-800 flex-none bg-slate-900">
          {copy.showingCount(effectiveFiles.length, effectiveTotalFiles.length)}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
          minWidth={180}
        />
      )}
    </SidebarSection>
  );
}

export default React.memo(FileTree);
