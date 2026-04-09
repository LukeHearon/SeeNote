import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Music, Film, FolderOpen, PanelLeftClose, PanelLeft, Shuffle, AlignJustify, UnfoldVertical, FoldVertical, RefreshCw } from 'lucide-react';

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
  currentFile: string | null;
  onFileSelect: (path: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  shuffleMode: boolean;
  onToggleShuffle: () => void;
  annotatedFiles: Set<string>;
  onRevealInFinder: (path: string) => void;
  onRevealAnnotations: (audioFilePath: string) => void;
  onRefresh: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  isAudioRoot?: boolean;
}

const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma']);

// OS-aware label for the system file browser
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('windows');
const finderLabel = isWindows ? 'File Explorer' : 'Finder';

function getExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

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
    const parts = rel.split('/');

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

function getAncestorPaths(currentFile: string | null, rootDirectory: string | null): Set<string> {
  const paths = new Set<string>();
  if (!currentFile || !rootDirectory) return paths;
  const rel = currentFile.substring(rootDirectory.length + 1);
  const parts = rel.split('/');
  let path = rootDirectory;
  for (let i = 0; i < parts.length - 1; i++) {
    path += '/' + parts[i];
    paths.add(path);
  }
  return paths;
}

interface TreeItemProps {
  node: TreeNode;
  currentFile: string | null;
  onFileSelect: (path: string) => void;
  depth: number;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
  annotatedFiles: Set<string>;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
}

const TreeItem: React.FC<TreeItemProps> = ({
  node,
  currentFile,
  onFileSelect,
  depth,
  expandedDirs,
  toggleDir,
  annotatedFiles,
  onContextMenu,
}) => {
  if (node.isDir) {
    const isExpanded = expandedDirs.has(node.path);
    return (
      <div>
        <button
          onClick={() => toggleDir(node.path)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
          className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors group"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {isExpanded
            ? <ChevronDown size={12} className="flex-none opacity-60" />
            : <ChevronRight size={12} className="flex-none opacity-60" />
          }
          <FolderOpen size={13} className="flex-none text-slate-500 group-hover:text-slate-300" />
          <span className="text-xs truncate">{node.name}</span>
          <span className="text-[10px] text-slate-600 ml-auto flex-none">{node.fileCount}</span>
        </button>
        {isExpanded && node.children.map(child => (
          <TreeItem
            key={child.path}
            node={child}
            currentFile={currentFile}
            onFileSelect={onFileSelect}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
            annotatedFiles={annotatedFiles}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    );
  }

  const isActive = node.path === currentFile;
  const isAudio = AUDIO_EXTS.has(getExt(node.name));
  const hasAnnotation = annotatedFiles.has(node.path);

  return (
    <button
      onClick={() => onFileSelect(node.path)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, false); }}
      className={`flex items-center gap-2 w-full py-1 text-left transition-colors ${
        isActive
          ? `bg-[#e65161]/20 ${hasAnnotation ? 'text-white' : 'text-[#e65161]'}`
          : hasAnnotation
            ? 'hover:bg-slate-800 text-sky-400 hover:text-sky-300'
            : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'
      }`}
      style={{ paddingLeft: `${depth * 12 + 22}px`, paddingRight: '8px' }}
      title={node.name}
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
  currentFile,
  onFileSelect,
  collapsed,
  onToggleCollapse,
  onNavigatePrev,
  onNavigateNext,
  canNavigatePrev,
  canNavigateNext,
  shuffleMode,
  onToggleShuffle,
  annotatedFiles,
  onRevealInFinder,
  onRevealAnnotations,
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
      setExpandedDirs(getAncestorPaths(currentFile, rootDirectory));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]); // intentionally snapshot currentFile/rootDirectory at tree-build time; file nav is handled below

  // Also auto-expand ancestors of the current file
  useEffect(() => {
    if (!currentFile || !rootDirectory) return;
    const rel = currentFile.substring(rootDirectory.length + 1);
    const parts = rel.split('/');
    setExpandedDirs(prev => {
      const next = new Set(prev);
      let path = rootDirectory;
      for (let i = 0; i < parts.length - 1; i++) {
        path += '/' + parts[i];
        next.add(path);
      }
      return next;
    });
  }, [currentFile, rootDirectory]);

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
    setExpandedDirs(getAncestorPaths(currentFile, rootDirectory));
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
      <div className="flex-none w-10 bg-slate-900 border-r border-slate-700 flex flex-col items-center pt-2 gap-2">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          title="Show file tree"
        >
          <PanelLeft size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex-none w-56 bg-slate-900 border-r border-slate-700 flex flex-col select-none h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-2 py-2 bg-slate-800 border-b border-slate-700 flex-none gap-1"
        onContextMenu={handleRootContextMenu}
      >
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <FolderOpen size={13} className="flex-none text-slate-500" />
          <span className="text-xs text-slate-400 truncate" title={rootDirectory || ''}>
            {dirName}
          </span>
          <span className="text-[10px] text-slate-600 flex-none">({allFiles.length})</span>
        </div>
        <div className="flex items-center gap-0.5 flex-none">
          {!shuffleMode && (
            <>
              <button
                onClick={expandAll}
                className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Expand all"
              >
                <UnfoldVertical size={13} />
              </button>
              <button
                onClick={collapseAll}
                className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Collapse all"
              >
                <FoldVertical size={13} />
              </button>
            </>
          )}
          <button
            onClick={onRefresh}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            title="Refresh file list"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={onToggleShuffle}
            className={`p-1 rounded hover:bg-slate-700 ${shuffleMode ? 'text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
            title={shuffleMode ? 'Switch to sorted view' : 'Shuffle queue'}
          >
            {shuffleMode ? <AlignJustify size={13} /> : <Shuffle size={13} />}
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            title="Collapse panel"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {!rootDirectory && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <FolderOpen size={28} className="mb-2 opacity-50" />
            <p className="text-xs">Open a file or folder to browse</p>
          </div>
        )}

        {/* Shuffle mode: flat list with relative paths */}
        {shuffleMode && rootDirectory && allFiles.map(filePath => {
          const rel = filePath.substring(rootDirectory.length + 1);
          const relNoExt = rel.replace(/\.[^/.]+$/, '');
          const isActive = filePath === currentFile;
          const isAudio = AUDIO_EXTS.has(getExt(filePath));
          const hasAnnotation = annotatedFiles.has(filePath);
          return (
            <button
              key={filePath}
              onClick={() => onFileSelect(filePath)}
              onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, filePath, false); }}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                isActive
                  ? `bg-[#e65161]/20 ${hasAnnotation ? 'text-white' : 'text-[#e65161]'}`
                  : hasAnnotation
                    ? 'hover:bg-slate-800 text-sky-400 hover:text-sky-300'
                    : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'
              }`}
              title={filePath}
            >
              {isAudio
                ? <Music size={12} className="flex-none opacity-70" />
                : <Film size={12} className="flex-none opacity-70" />
              }
              <span className="text-xs truncate flex-1">{relNoExt}</span>
            </button>
          );
        })}

        {/* Normal tree mode */}
        {!shuffleMode && tree.map(node => (
          <TreeItem
            key={node.path}
            node={node}
            currentFile={currentFile}
            onFileSelect={onFileSelect}
            depth={0}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
            annotatedFiles={annotatedFiles}
            onContextMenu={handleContextMenu}
          />
        ))}
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
            {contextMenu.isDir
              ? `Show Folder in ${finderLabel}`
              : AUDIO_EXTS.has(getExt(contextMenu.path.split('/').pop() ?? ''))
                ? `Show Audio in ${finderLabel}`
                : `Show Video in ${finderLabel}`}
          </button>
          {/* Only show "Show Annotations in Finder" for files that have an annotation */}
          {!contextMenu.isDir && annotatedFiles.has(contextMenu.path) && (
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
        </div>
      )}
    </div>
  );
}

export default React.memo(FileTree);
