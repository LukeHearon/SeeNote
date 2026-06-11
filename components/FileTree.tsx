import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Music, Film, FolderOpen, PanelLeftClose, PanelLeft, Shuffle, AlignJustify, UnfoldVertical, FoldVertical, RefreshCw, EyeOff, Eye, Filter } from 'lucide-react';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  fileCount: number; // precomputed — no recursive counting at render time
}

interface FileTreeProps {
  rootDirectory: string | null;
  allFiles: string[];
  currentTrack: string | null;
  onFileSelect: (path: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
  onRefresh: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  isAudioRoot?: boolean;
}

import { isSupportedMediaFile, SUPPORTED_AUDIO_EXTS, getExt } from '../constants';
import { stripExt } from '../utils/helpers';

// OS-aware label for the system file browser
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('windows');
const finderLabel = isWindows ? 'File Explorer' : 'Finder';

function computeFileCount(node: TreeNode): number {
  if (!node.isDir) return 1;
  let count = 0;
  for (const c of node.children) count += computeFileCount(c);
  node.fileCount = count;
  return count;
}

function buildTree(rootDir: string, files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: rootDir, isDir: true, children: [], fileCount: 0 };

  for (const file of files) {
    const rel = file.substring(rootDir.length + 1);
    const parts = rel.split(/[\\/]/);

    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        node.children.push({ name: part, path: file, isDir: false, children: [], fileCount: 1 });
      } else {
        // Use a Map stored on the node for O(1) child lookups during tree building
        if (!(node as any)._dirMap) (node as any)._dirMap = new Map<string, TreeNode>();
        const dirMap = (node as any)._dirMap as Map<string, TreeNode>;
        let child = dirMap.get(part);
        if (!child) {
          const dirPath = rootDir + '/' + parts.slice(0, i + 1).join('/');
          child = { name: part, path: dirPath, isDir: true, children: [], fileCount: 0 };
          dirMap.set(part, child);
          node.children.push(child);
        }
        node = child;
      }
    }
  }

  // Precompute file counts bottom-up
  for (const child of root.children) computeFileCount(child);

  return root.children;
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
  toggleDir: (path: string) => void;
  annotatedTracks: Set<string>;
  ancestorPaths: Set<string>;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
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
}) => {
  if (node.isDir) {
    const isExpanded = expandedDirs.has(node.path);
    const isClosedAncestor = !isExpanded && ancestorPaths.has(node.path);
    return (
      <div>
        <button
          onClick={() => toggleDir(node.path)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
          className={`flex items-center gap-1 w-full px-2 py-1 text-left transition-colors group ${
            isClosedAncestor
              ? 'bg-[#e65161]/10 hover:bg-[#e65161]/20 text-[#e65161]'
              : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {isExpanded
            ? <ChevronDown size={12} className="flex-none opacity-60" />
            : <ChevronRight size={12} className="flex-none opacity-60" />
          }
          <FolderOpen size={13} className={`flex-none ${isClosedAncestor ? 'text-[#e65161]/70' : 'text-slate-500 group-hover:text-slate-300'}`} />
          <span className="text-xs truncate">{node.name}</span>
          <span className={`text-[10px] ml-auto flex-none ${isClosedAncestor ? 'text-[#e65161]/50' : 'text-slate-600'}`}>{node.fileCount}</span>
        </button>
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
          />
        ))}
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
      >
        {isAudio
          ? <Music size={12} className="flex-none opacity-40" />
          : <Film size={12} className="flex-none opacity-40" />
        }
        <span className="text-xs truncate flex-1 italic">{node.name}</span>
        <span className="text-[10px] flex-none opacity-70">(unsupported)</span>
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
      data-tooltip={node.name}
      data-active-file={isActive ? '' : undefined}
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
  currentTrack,
  onFileSelect,
  collapsed,
  onToggleCollapse,
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
  onRefresh,
}: FileTreeProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => {
    if (!rootDirectory || allFiles.length === 0) return [];
    return buildTree(rootDirectory, allFiles);
  }, [rootDirectory, allFiles]);

  // On tree build/rebuild, start with only the current file's ancestors expanded
  useEffect(() => {
    if (tree.length > 0) {
      setExpandedDirs(getAncestorPaths(currentTrack, rootDirectory));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]); // intentionally snapshot currentTrack/rootDirectory at tree-build time; file nav is handled below

  // Also auto-expand ancestors of the current file
  useEffect(() => {
    if (!currentTrack || !rootDirectory) return;
    const rel = currentTrack.substring(rootDirectory.length + 1);
    const parts = rel.split(/[\\/]/);
    setExpandedDirs(prev => {
      const next = new Set(prev);
      let path = rootDirectory;
      for (let i = 0; i < parts.length - 1; i++) {
        path += '/' + parts[i];
        next.add(path);
      }
      return next;
    });
  }, [currentTrack, rootDirectory]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedDirs(new Set(getAllDirPaths(tree)));
  };

  const collapseAll = () => {
    // Collapse everything — ancestor dirs of the active file are highlighted
    // rather than auto-expanded, so the user still knows where it lives.
    setExpandedDirs(new Set());
  };

  const allDirPaths = useMemo(() => getAllDirPaths(tree), [tree]);
  const isAnyExpanded = expandedDirs.size > 0;

  // ── Custom scrollbar ──────────────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const [activeItemFraction, setActiveItemFraction] = useState<number | null>(null);
  const activeItemFractionRef = useRef<number | null>(null);
  const isDraggingThumb = useRef(false);
  const thumbDragStartY = useRef(0);
  const thumbDragStartScrollTop = useRef(0);

  useEffect(() => { activeItemFractionRef.current = activeItemFraction; }, [activeItemFraction]);

  const syncScrollbar = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
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
  }, []);

  // When the active track changes, nudge the scroll so the item is visible:
  // - if it's above the viewport, make it the first visible row
  // - if it's below the viewport, make it the last visible row
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const activeEl = el.querySelector('[data-active-file]') as HTMLElement | null;
    if (!activeEl) return;
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

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, []);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    if (!rootDirectory) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path: rootDirectory, isDir: true, isAudioRoot: true });
  }, [rootDirectory]);

  const dirName = rootDirectory?.split('/').pop() || 'No folder';

  if (collapsed) {
    return (
      <div className="flex flex-col items-center pt-2 gap-2 h-full">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          data-tooltip="Show file tree"
        >
          <PanelLeft size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col select-none h-full bg-slate-900 w-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-2 py-2 bg-slate-800 border-b border-slate-700 flex-none gap-1"
        onContextMenu={handleRootContextMenu}
      >
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <FolderOpen size={13} className="flex-none text-slate-500" />
          <span className="text-xs text-slate-400 truncate" data-tooltip={rootDirectory || ''}>
            {dirName}
          </span>
          <span className="text-[10px] text-slate-600 flex-none">({allFiles.length})</span>
        </div>
        <div className="flex items-center gap-0.5 flex-none">
          {!shuffleMode && (
            <button
              onClick={toggleExpandCollapse}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
              data-tooltip={isAnyExpanded ? 'Collapse all' : 'Expand all'}
            >
              {isAnyExpanded ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
            </button>
          )}
          <button
            onClick={onRefresh}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            data-tooltip="Refresh file list"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={onToggleFileFilter}
            className={`p-1 rounded hover:bg-slate-700 ${fileFilter !== 'all' ? 'text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
            data-tooltip={fileFilter === 'all' ? 'Show all files' : fileFilter === 'unannotated' ? 'Showing: unannotated only' : 'Showing: annotated only'}
          >
            {fileFilter === 'all' ? <Eye size={13} /> : fileFilter === 'unannotated' ? <EyeOff size={13} /> : <Filter size={13} />}
          </button>
          <button
            onClick={onToggleShuffle}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            data-tooltip={shuffleMode ? 'Switch to sorted view' : 'Shuffle queue'}
          >
            {shuffleMode ? <AlignJustify size={13} /> : <Shuffle size={13} />}
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            data-tooltip="Collapse panel"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* File list — flex row so scrollbar track is a true sibling, not an overlay */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="flex-1 min-w-0 overflow-y-scroll no-scrollbar"
          onScroll={syncScrollbar}
        >
        {!rootDirectory && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <FolderOpen size={28} className="mb-2 opacity-50" />
            <p className="text-xs">Open a file or folder to browse</p>
          </div>
        )}

        {/* Shuffle mode: windowed flat list (±105 files around current, fade at edges only when files are hidden there) */}
        {shuffleMode && rootDirectory && (() => {
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
                      <span className="text-[10px] flex-none opacity-70">(unsupported)</span>
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
                    data-tooltip={filePath}
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
          const ancestorPaths = getAncestorPaths(currentTrack, rootDirectory);
          return tree.map(node => (
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
            />
          ));
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

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 text-left"
            onClick={() => {
              onRevealInFinder(contextMenu.path);
              setContextMenu(null);
            }}
          >
            {`Show media in ${finderLabel}`}
          </button>
          {!contextMenu.isDir && annotatedTracks.has(contextMenu.path) && (
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 text-left"
              onClick={() => {
                onRevealAnnotations(contextMenu.path);
                setContextMenu(null);
              }}
            >
              {`Show Annotations in ${finderLabel}`}
            </button>
          )}
          {contextMenu.isDir && !contextMenu.isAudioRoot && (
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 text-left"
              onClick={() => {
                onRevealAnnotations(contextMenu.path);
                setContextMenu(null);
              }}
            >
              {`Show Annotations in ${finderLabel}`}
            </button>
          )}
          {contextMenu.isAudioRoot && onRevealAnnotationsRoot && (
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 text-left"
              onClick={() => {
                onRevealAnnotationsRoot();
                setContextMenu(null);
              }}
            >
              {`Show Annotations in ${finderLabel}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default React.memo(FileTree);
