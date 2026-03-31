import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown, Music, Film, FolderOpen, PanelLeftClose, PanelLeft, ChevronUp, ChevronDownIcon } from 'lucide-react';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
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
}

const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma']);

function getExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function buildTree(rootDir: string, files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: rootDir, isDir: true, children: [] };

  for (const file of files) {
    const rel = file.substring(rootDir.length + 1);
    const parts = rel.split('/');

    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        node.children.push({ name: part, path: file, isDir: false, children: [] });
      } else {
        let child = node.children.find(c => c.isDir && c.name === part);
        if (!child) {
          const dirPath = rootDir + '/' + parts.slice(0, i + 1).join('/');
          child = { name: part, path: dirPath, isDir: true, children: [] };
          node.children.push(child);
        }
        node = child;
      }
    }
  }

  return root.children;
}

interface TreeItemProps {
  node: TreeNode;
  currentFile: string | null;
  onFileSelect: (path: string) => void;
  depth: number;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
}

const TreeItem: React.FC<TreeItemProps> = ({
  node,
  currentFile,
  onFileSelect,
  depth,
  expandedDirs,
  toggleDir,
}) => {
  if (node.isDir) {
    const isExpanded = expandedDirs.has(node.path);
    return (
      <div>
        <button
          onClick={() => toggleDir(node.path)}
          className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors group"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {isExpanded
            ? <ChevronDown size={12} className="flex-none opacity-60" />
            : <ChevronRight size={12} className="flex-none opacity-60" />
          }
          <FolderOpen size={13} className="flex-none text-slate-500 group-hover:text-slate-300" />
          <span className="text-xs truncate">{node.name}</span>
          <span className="text-[10px] text-slate-600 ml-auto flex-none">{node.children.filter(c => !c.isDir).length}</span>
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
          />
        ))}
      </div>
    );
  }

  const isActive = node.path === currentFile;
  const isAudio = AUDIO_EXTS.has(getExt(node.name));

  return (
    <button
      onClick={() => onFileSelect(node.path)}
      className={`flex items-center gap-2 w-full py-1 text-left transition-colors ${
        isActive
          ? 'bg-[#e65161]/20 text-[#e65161]'
          : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
      }`}
      style={{ paddingLeft: `${depth * 12 + 22}px`, paddingRight: '8px' }}
      title={node.name}
    >
      {isAudio
        ? <Music size={12} className="flex-none opacity-70" />
        : <Film size={12} className="flex-none opacity-70" />
      }
      <span className="text-xs truncate">{node.name}</span>
    </button>
  );
};

export default function FileTree({
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
}: FileTreeProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    if (!rootDirectory || allFiles.length === 0) return [];
    return buildTree(rootDirectory, allFiles);
  }, [rootDirectory, allFiles]);

  // Auto-expand directories containing the current file
  useEffect(() => {
    if (!currentFile || !rootDirectory) return;
    const rel = currentFile.substring(rootDirectory.length + 1);
    const parts = rel.split('/');
    const newExpanded = new Set(expandedDirs);
    let path = rootDirectory;
    for (let i = 0; i < parts.length - 1; i++) {
      path += '/' + parts[i];
      newExpanded.add(path);
    }
    setExpandedDirs(newExpanded);
  }, [currentFile, rootDirectory]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

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
        {canNavigatePrev && (
          <button onClick={onNavigatePrev} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white" title="Previous file ([)">
            <ChevronUp size={16} />
          </button>
        )}
        {canNavigateNext && (
          <button onClick={onNavigateNext} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white" title="Next file (])">
            <ChevronDownIcon size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-none w-56 bg-slate-900 border-r border-slate-700 flex flex-col select-none h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-2 bg-slate-800 border-b border-slate-700 flex-none gap-1">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <FolderOpen size={13} className="flex-none text-slate-500" />
          <span className="text-xs text-slate-400 truncate" title={rootDirectory || ''}>
            {dirName}
          </span>
          <span className="text-[10px] text-slate-600 flex-none">({allFiles.length})</span>
        </div>
        <div className="flex items-center gap-0.5 flex-none">
          <button
            onClick={onNavigatePrev}
            disabled={!canNavigatePrev}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous file ([)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={onNavigateNext}
            disabled={!canNavigateNext}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next file (])"
          >
            <ChevronDownIcon size={14} />
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

      {/* Tree */}
      <div className="flex-1 overflow-y-auto">
        {!rootDirectory && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <FolderOpen size={28} className="mb-2 opacity-50" />
            <p className="text-xs">Open a file or folder to browse</p>
          </div>
        )}
        {tree.map(node => (
          <TreeItem
            key={node.path}
            node={node}
            currentFile={currentFile}
            onFileSelect={onFileSelect}
            depth={0}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
          />
        ))}
      </div>
    </div>
  );
}
