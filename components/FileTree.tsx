import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronsLeft, Music, FolderOpen, PanelLeft, EyeOff } from 'lucide-react';
import type { FileFilter } from '../utils/fileFilter';
import { totalCounts } from '../utils/fileTreeCounts';
import { columnLayout } from '../utils/fileTreeColumns';
import {
  applyExpandAction, buildTree, ExpandAction, filterUnderDir, flattenTree, getAncestorPaths, getExpandAction, toggleDirInSet, TreeNode,
} from '../utils/fileTreeBuild';
import { FilePanelHeaderButtons } from './controls/FilePanelHeaderButtons';
import SidebarSection from './SidebarSection';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import FileTreeScrollbar from './FileTreeScrollbar';
import PinnedBreadcrumb, { breadcrumbInset } from './PinnedBreadcrumb';
import { FileRow, FolderRow, NonMediaToggle, NonMediaItem, FilenameTimeInfo } from './FileRow';
import { fileTree as copy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { isSupportedMediaFile } from '../constants';
import { stripExt } from '../utils/helpers';
import { basename, dirname } from '../utils/projectPaths';
import { fileManagerLabel } from '../utils/platform';

export type { FilenameTimeInfo };

interface FileTreeProps {
  rootDirectory: string | null;
  /** Any directory scan (media, annotations, buzzdetect) is running — drives the progress bar. */
  isScanning: boolean;
  /** The media directory itself is still being scanned, so an empty list means "not yet". */
  isScanningMedia: boolean;
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
  shuffleMode: boolean;
  /** Shuffle the tracks inside `folder` (entering it first if it isn't the current folder). */
  onStartShuffle: (folder: string) => void;
  onStopShuffle: () => void;
  annotatedTracks: Set<string>;
  /** Tracks with buzzdetect results. Empty unless the project has a buzzdetect directory. */
  buzzdetectTracks: Set<string>;
  /** Whether the project names a buzzdetect directory — gates the buzzdetect column and filter. */
  showBuzzdetect: boolean;
  fileFilter: FileFilter;
  onToggleFileFilter: () => void;
  buzzdetectFilter: FileFilter;
  onToggleBuzzdetectFilter: () => void;
  /** Set a filter straight back to unfiltered (the empty state's "turn off" links). */
  onClearFileFilter: () => void;
  onClearBuzzdetectFilter: () => void;
  /** Rescan the media directory from scratch. */
  onRefreshFileTree: () => void;
  onRevealInFinder: (path: string) => void;
  onRevealAnnotations: (audioFilePath: string) => void;
  onRevealAnnotationsRoot?: () => void;
  onImportAnnotations: (audioFilePath: string) => void;
  /**
   * The folder the panel is currently entered into, as persisted. Half-
   * controlled: the panel drives it through `onEnteredFolderChange` as the user
   * enters and leaves folders, but a change that arrives from outside is adopted
   * — navigating to a find match beyond the entered folder steps the panel back
   * out to the root (see handleGoToLabelMatch).
   */
  enteredFolderPath?: string | null;
  onEnteredFolderChange?: (path: string | null) => void;
  nonMediaFiles?: string[];
  filenameTimeInfo: FilenameTimeInfo;
  /**
   * Reports the header state the guide's live copy of these buttons needs, plus
   * the one action (expand/collapse) whose state lives inside this component.
   * Called whenever `anyExpanded` or `expandAction` changes; the action itself is stable and reads
   * current state when invoked.
   */
  onHeaderState?: (state: { anyExpanded: boolean; expandAction: ExpandAction; toggleExpandCollapse: () => void }) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  isAudioRoot?: boolean;
}

// Shuffle mode shows a windowed flat list around the current track.
const SHUFFLE_WINDOW = 105;
const FADE_ZONE = 5; // items at each edge that fade, but only when files are hidden on that side
// Only the few rows with the longest estimated names are measured for the columns.
const NAME_MEASURE_CANDIDATES = 6;

function FileTree({
  rootDirectory,
  isScanning,
  isScanningMedia,
  allFiles,
  allFilesUnfiltered,
  currentTrack,
  onFileSelect,
  collapsed,
  onToggleCollapse,
  sectionCollapsed,
  onToggleSectionCollapsed,
  shuffleMode,
  onStartShuffle,
  onStopShuffle,
  annotatedTracks,
  buzzdetectTracks,
  showBuzzdetect,
  fileFilter,
  onToggleFileFilter,
  buzzdetectFilter,
  onToggleBuzzdetectFilter,
  onClearFileFilter,
  onClearBuzzdetectFilter,
  onRefreshFileTree,
  onRevealInFinder,
  onRevealAnnotations,
  onRevealAnnotationsRoot,
  onImportAnnotations,
  enteredFolderPath,
  onEnteredFolderChange,
  nonMediaFiles,
  filenameTimeInfo: filenameTimeInfoProp,
  onHeaderState,
}: FileTreeProps) {
  // Callers pass a fresh object each render; rows memoize on this one.
  const { pattern, offsetSeparator, dateTimeFormat } = filenameTimeInfoProp;
  const filenameTimeInfo = useMemo(
    () => ({ pattern, offsetSeparator, dateTimeFormat }),
    [pattern, offsetSeparator, dateTimeFormat],
  );

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [enteredPath, setEnteredPath] = useState<string | null>(enteredFolderPath ?? null);
  const scrollToFolderRef = useRef<string | null>(null);
  const [expandedNonMedia, setExpandedNonMedia] = useState<Set<string>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Mirror of enteredPath, so the effect below can tell a folder change the panel
  // made itself (which arrives here as an echo) from one imposed from outside.
  const enteredPathRef = useRef(enteredPath);
  enteredPathRef.current = enteredPath;

  // Adopt a folder set from outside — navigating to a find match beyond the
  // entered folder steps the panel back out to the root. The panel's own
  // enter/leave arrives as an echo and is skipped, so this can't undo goUpOne's
  // "reveal the folder you just left".
  useEffect(() => {
    const next = enteredFolderPath ?? null;
    if (enteredPathRef.current === next) return;
    setEnteredPath(next);
    setExpandedDirs(new Set());
  }, [enteredFolderPath]);

  // A new media root invalidates every path the tree was holding open.
  useEffect(() => {
    setEnteredPath(enteredFolderPath ?? null);
    setExpandedDirs(new Set());
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
    const parent = dirname(enteredPath);
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
  const effectiveFiles = useMemo(
    () => (enteredPath ? filterUnderDir(allFiles, enteredPath) : allFiles),
    [enteredPath, allFiles],
  );
  const effectiveTotalFiles = useMemo(
    () => (enteredPath ? filterUnderDir(allFilesUnfiltered, enteredPath) : allFilesUnfiltered),
    [enteredPath, allFilesUnfiltered],
  );
  const effectiveNonMediaFiles = useMemo(() => {
    if (!nonMediaFiles || !effectiveRoot) return [];
    return enteredPath ? filterUnderDir(nonMediaFiles, enteredPath) : nonMediaFiles;
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
    return buildTree(effectiveRoot, effectiveFiles, effectiveNonMediaFiles, annotatedTracks, buzzdetectTracks, effectiveTotalFiles);
  }, [effectiveRoot, effectiveFiles, effectiveNonMediaFiles, annotatedTracks, buzzdetectTracks, effectiveTotalFiles]);
  const treeRef = useRef<TreeNode[]>(tree);
  treeRef.current = tree;

  // Header count for the entered dir — the whole (unfiltered) project total, so
  // it doesn't move when a filter is toggled.
  const rootCounts = useMemo(
    () => totalCounts(effectiveTotalFiles, annotatedTracks, buzzdetectTracks),
    [effectiveTotalFiles, annotatedTracks, buzzdetectTracks],
  );

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
    const ancestors = getAncestorPaths(currentTrack, effectiveRoot);
    setExpandedDirs(prev => {
      for (const p of ancestors) if (!prev.has(p)) return new Set([...prev, ...ancestors]);
      return prev;
    });
  }, [currentTrack, effectiveRoot]);

  // Expanding or collapsing a folder on its own must never move the view, so
  // user-driven toggles drop any pending scroll-to-active request (see below).
  const pendingActiveScrollRef = useRef(true);
  const cancelPendingActiveScroll = useCallback(() => {
    pendingActiveScrollRef.current = false;
  }, []);

  const toggleDir = useCallback((node: TreeNode) => {
    cancelPendingActiveScroll();
    setExpandedDirs(prev => toggleDirInSet(prev, node));
  }, [cancelPendingActiveScroll]);

  // Stable, and reads state when invoked, so the guide's copy (which holds the
  // first one it was handed) never acts on a stale tree. Collapsing leaves the
  // active file's ancestors highlighted rather than expanded.
  const toggleExpandCollapse = useCallback(() => {
    cancelPendingActiveScroll();
    setExpandedDirs(prev => applyExpandAction(treeRef.current, getExpandAction(treeRef.current, prev)));
  }, [cancelPendingActiveScroll]);

  const isAnyExpanded = expandedDirs.size > 0;
  const expandAction = useMemo(() => getExpandAction(tree, expandedDirs), [tree, expandedDirs]);

  // Publish the header state upward for the guide's live copy of these buttons.
  useEffect(() => {
    onHeaderState?.({ anyExpanded: isAnyExpanded, expandAction, toggleExpandCollapse });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnyExpanded, expandAction, toggleExpandCollapse]);

  // Rows on screen: the expanded tree, or the shuffle window around the current track.
  const treeRows = useMemo(
    () => (shuffleMode || !effectiveRoot ? [] : flattenTree(tree, effectiveRoot, expandedDirs, expandedNonMedia, rootNonMedia)),
    [shuffleMode, tree, effectiveRoot, expandedDirs, expandedNonMedia, rootNonMedia],
  );
  const shuffleView = useMemo(() => {
    if (!shuffleMode) return null;
    const currentIdx = allFiles.indexOf(currentTrack ?? '');
    const startIdx = Math.max(0, currentIdx >= 0 ? currentIdx - SHUFFLE_WINDOW : 0);
    const endIdx = Math.min(allFiles.length - 1, currentIdx >= 0 ? currentIdx + SHUFFLE_WINDOW : SHUFFLE_WINDOW * 2);
    return { startIdx, endIdx, visible: allFiles.slice(startIdx, endIdx + 1) };
  }, [shuffleMode, allFiles, currentTrack]);
  const ancestorPaths = useMemo(() => getAncestorPaths(currentTrack, effectiveRoot), [currentTrack, effectiveRoot]);

  // Changes whenever what's on screen may have changed size or position —
  // the scrollbar and breadcrumb re-measure on it.
  const layoutKey = useMemo(() => ({}), [treeRows, shuffleView, currentTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the active track changes, nudge the scroll so the item is visible:
  // - if it's above the viewport (or under the breadcrumb), make it the first
  //   visible row below the breadcrumb
  // - if it's below the viewport, make it the last visible row
  //
  // The row may not be in the DOM on the render where `currentTrack` changes —
  // the ancestor-expanding effect above is a plain effect, so it reveals the row
  // a render later. The request is therefore held in a ref and consumed on
  // whichever render first paints the row. `expandedDirs` is in the deps purely
  // to get that retry.
  const scrolledForTrackRef = useRef<string | null>(null);
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
    if (topRelative < breadcrumbInset(el, el.scrollTop)) {
      const target = el.scrollTop + topRelative;
      el.scrollTop = target - breadcrumbInset(el, target);
    } else if (bottomRelative > el.clientHeight) {
      el.scrollTop += bottomRelative - el.clientHeight;
    }
  }, [currentTrack, expandedDirs]);

  useLayoutEffect(() => {
    const path = scrollToFolderRef.current;
    if (!path) return;
    scrollToFolderRef.current = null;
    const el = scrollContainerRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-folder-path="${CSS.escape(path)}"]`) as HTMLElement | null;
    if (!target) return;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, [expandedDirs]);

  // Width available to rows, which decides whether the result columns fit.
  const [listWidth, setListWidth] = useState(0);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListWidth(el.clientWidth));
    ro.observe(el);
    setListWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [collapsed, sectionCollapsed]);
  // How far right the longest rendered name reaches, measured off the names'
  // own (unclipped) text. Columns only appear beside names that fit, so this
  // is what they have to leave room for. Independent of the columns themselves
  // (they sit to the right of the names), so showing one can't change it.
  // Rows tag their name with an estimated reach, so only the few likeliest to
  // be widest are measured rather than every row in the tree.
  const [nameNeededPx, setNameNeededPx] = useState(0);
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const names = Array.from(el.querySelectorAll<HTMLElement>('[data-name-text]'));
    names.sort((a, b) => Number(b.dataset.nameText) - Number(a.dataset.nameText));
    const left = el.getBoundingClientRect().left;
    let max = 0;
    for (const n of names.slice(0, NAME_MEASURE_CANDIDATES)) {
      max = Math.max(max, n.getBoundingClientRect().right - left);
    }
    setNameNeededPx(Math.ceil(max));
  }, [layoutKey, collapsed, sectionCollapsed]);
  const columns = useMemo(
    () => columnLayout(listWidth, Math.max(rootCounts.total, 1), showBuzzdetect, nameNeededPx),
    [listWidth, rootCounts.total, showBuzzdetect, nameNeededPx],
  );

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

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const dirName = enteredPath ? basename(enteredPath) : (rootDirectory ? basename(rootDirectory) : copy.noFolder);

  const menuItems = (m: ContextMenuState): ContextMenuItem[] => {
    const manager = fileManagerLabel();
    const items: ContextMenuItem[] = [
      { label: copy.showMediaIn(manager), onSelect: () => onRevealInFinder(m.path) },
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
    // Shuffle. A folder (or the panel header, which stands for the current
    // folder) shuffles the tracks inside it; while shuffling, any menu can stop it.
    if (m.isDir && rootDirectory) {
      items.push({ label: shuffleMode ? copy.reshuffle : copy.shuffleFolder, onSelect: () => onStartShuffle(m.path) });
    }
    if (shuffleMode) {
      items.push({ label: copy.stopShuffle, onSelect: onStopShuffle });
    }
    const showsAnnotations = (!m.isDir && annotatedTracks.has(m.path)) || (m.isDir && !m.isAudioRoot);
    if (showsAnnotations) {
      items.push({ label: copy.showAnnotationsIn(manager), onSelect: () => onRevealAnnotations(m.path) });
    } else if (m.isAudioRoot && onRevealAnnotationsRoot) {
      items.push({ label: copy.showAnnotationsIn(manager), onSelect: onRevealAnnotationsRoot });
    }
    items.push({ label: copy.refreshFileTree, onSelect: onRefreshFileTree });
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

  const renderTreeRow = (row: (typeof treeRows)[number]) => {
    switch (row.kind) {
      case 'dir':
        return (
          <FolderRow
            key={row.key}
            node={row.node}
            depth={row.depth}
            parentPath={row.parentPath}
            expanded={row.expanded}
            isClosedAncestor={!row.expanded && ancestorPaths.has(row.node.path)}
            columns={columns}
            onToggle={toggleDir}
            onEnter={enterFolder}
            onContextMenu={handleContextMenu}
          />
        );
      case 'file':
        return (
          <FileRow
            key={row.key}
            variant="tree"
            path={row.node.path}
            label={row.node.name}
            depth={row.depth}
            parentPath={row.parentPath}
            isActive={row.node.path === currentTrack}
            hasAnnotation={annotatedTracks.has(row.node.path)}
            hasBuzzdetect={buzzdetectTracks.has(row.node.path)}
            columns={columns}
            filenameTimeInfo={filenameTimeInfo}
            onSelect={onFileSelect}
            onContextMenu={handleContextMenu}
          />
        );
      case 'nonMediaToggle':
        return <NonMediaToggle key={row.key} path={row.path} count={row.count} depth={row.depth} expanded={row.expanded} onToggle={toggleNonMedia} />;
      case 'nonMediaItem':
        return <NonMediaItem key={row.key} filePath={row.filePath} depth={row.depth} crumb={row.crumb} />;
    }
  };

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
            ({rootCounts.annotated}/{rootCounts.total})
          </span>
        </>
      )}
      actions={(
        <FilePanelHeaderButtons
          shuffleMode={shuffleMode}
          anyExpanded={isAnyExpanded}
          expandAction={expandAction}
          fileFilter={fileFilter}
          showBuzzdetect={showBuzzdetect}
          buzzdetectFilter={buzzdetectFilter}
          onToggleExpandCollapse={toggleExpandCollapse}
          onToggleFileFilter={onToggleFileFilter}
          onToggleBuzzdetectFilter={onToggleBuzzdetectFilter}
          columns={columns}
        />
      )}
    >
      {/* File list — inner flex row keeps the scrollbar track a true sibling, not an overlay */}
      <div className="relative flex-1 min-h-0 flex overflow-hidden bg-slate-900 select-none">
        <PinnedBreadcrumb containerRef={scrollContainerRef} syncKey={layoutKey} root={effectiveRoot} onEnterFolder={enterFolder} />
        <div
          ref={scrollContainerRef}
          className="flex-1 min-w-0 overflow-y-scroll no-scrollbar"
          onScroll={e => { lastScrollTopRef.current = e.currentTarget.scrollTop; }}
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
            <p className="text-sm">{isScanningMedia ? copy.scanning : copy.noMediaFiles}</p>
          </div>
        )}

        {rootDirectory && effectiveTotalFiles.length > 0 && effectiveFiles.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <EyeOff size={28} className="mb-2 opacity-50" />
            <p className="text-sm">{copy.noFilesMatchFilter}</p>
            <ul className="mt-1 text-xs space-y-0.5">
              {[
                fileFilter !== 'all' && {
                  key: 'annotations',
                  label: fileFilter === 'annotated' ? copy.annotatedFilterLabel : copy.unannotatedFilterLabel,
                  clear: onClearFileFilter,
                },
                showBuzzdetect && buzzdetectFilter !== 'all' && {
                  key: 'buzzdetect',
                  label: buzzdetectFilter === 'annotated' ? copy.buzzdetectHasFilterLabel : copy.buzzdetectNoneFilterLabel,
                  clear: onClearBuzzdetectFilter,
                },
              ].filter((f): f is { key: string; label: string; clear: () => void } => !!f).map(f => (
                <li key={f.key}>
                  {f.label}{' '}
                  <button onClick={f.clear} className="underline decoration-dotted hover:text-slate-400">{copy.filterTurnOff}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Shuffle mode: windowed flat list (±105 files around current, fade at edges only when files are hidden there) */}
        {shuffleView && rootDirectory && effectiveFiles.length > 0 && (() => {
          const { startIdx, endIdx, visible } = shuffleView;
          const hasMoreBefore = startIdx > 0;
          const hasMoreAfter = endIdx < allFiles.length - 1;
          return (
            <>
              {hasMoreBefore && (
                <div className="px-3 py-1 text-[10px] text-slate-600 italic select-none">{copy.notShown(startIdx)}</div>
              )}
              {visible.map((filePath, i) => {
                const distFromTop = i;
                const distFromBottom = endIdx - (startIdx + i);
                let opacity = 1;
                if (hasMoreBefore && distFromTop < FADE_ZONE) opacity = Math.min(opacity, (distFromTop + 1) / (FADE_ZONE + 1));
                if (hasMoreAfter && distFromBottom < FADE_ZONE) opacity = Math.min(opacity, (distFromBottom + 1) / (FADE_ZONE + 1));
                return (
                  <FileRow
                    key={filePath}
                    variant="flat"
                    path={filePath}
                    label={stripExt(filePath.substring(rootDirectory.length + 1))}
                    isActive={filePath === currentTrack}
                    hasAnnotation={annotatedTracks.has(filePath)}
                    hasBuzzdetect={buzzdetectTracks.has(filePath)}
                    columns={columns}
                    opacity={opacity}
                    filenameTimeInfo={filenameTimeInfo}
                    onSelect={onFileSelect}
                    onContextMenu={handleContextMenu}
                  />
                );
              })}
              {hasMoreAfter && (
                <div className="px-3 py-1 text-[10px] text-slate-600 italic select-none">{copy.notShown(allFiles.length - 1 - endIdx)}</div>
              )}
            </>
          );
        })()}

        {/* Normal tree mode */}
        {!shuffleMode && treeRows.map(renderTreeRow)}
        </div>{/* end scroll container */}

        <FileTreeScrollbar containerRef={scrollContainerRef} syncKey={layoutKey} />
      </div>

      {isScanning && rootDirectory && (
        <div className="relative h-0.5 flex-none overflow-hidden bg-slate-800" role="progressbar" aria-label={copy.scanning}>
          <div className="scan-bounce absolute inset-y-0 w-1/3 bg-[#e65161]" />
        </div>
      )}

      {rootDirectory && effectiveFiles.length < effectiveTotalFiles.length && (
        <div className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-800 flex-none bg-slate-900">
          {copy.showingCount(effectiveFiles.length, effectiveTotalFiles.length)}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu)}
          onClose={closeContextMenu}
          minWidth={180}
        />
      )}
    </SidebarSection>
  );
}

export default React.memo(FileTree);
