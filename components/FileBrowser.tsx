import React, { useState, useEffect } from 'react';
import { Folder, FolderOpen, Music, Film, ChevronRight, ChevronLeft, FolderInput } from 'lucide-react';
import { listDirectory, openDirectoryDialog, DirEntry } from '../utils/tauriCommands';

interface FileBrowserProps {
  currentDirectory: string | null;
  currentFile: string | null;
  onFileSelect: (absolutePath: string) => void;
  onDirectoryChange: (absolutePath: string) => void;
}

export default function FileBrowser({
  currentDirectory,
  currentFile,
  onFileSelect,
  onDirectoryChange,
}: FileBrowserProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentDirectory) {
      setEntries([]);
      return;
    }
    listDirectory(currentDirectory)
      .then(setEntries)
      .catch(e => setError(String(e)));
  }, [currentDirectory]);

  const handleOpenFolder = async () => {
    const path = await openDirectoryDialog();
    if (path) onDirectoryChange(path);
  };

  const handleGoUp = () => {
    if (!currentDirectory) return;
    const parent = currentDirectory.substring(0, currentDirectory.lastIndexOf('/'));
    if (parent) onDirectoryChange(parent);
  };

  const dirName = currentDirectory
    ? currentDirectory.split('/').pop() || currentDirectory
    : null;

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700 w-56 select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700 flex-none">
        <div className="flex items-center gap-1 min-w-0">
          {currentDirectory && (
            <button
              onClick={handleGoUp}
              className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white flex-none"
              data-tooltip="Go up"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          <span className="text-xs text-slate-400 truncate" data-tooltip={currentDirectory || ''}>
            {dirName || 'No folder open'}
          </span>
        </div>
        <button
          onClick={handleOpenFolder}
          className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white flex-none ml-1"
          data-tooltip="Open folder"
        >
          <FolderInput size={14} />
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <p className="text-xs text-red-400 px-3 py-2">{error}</p>
        )}
        {!currentDirectory && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 px-4 text-center">
            <FolderOpen size={28} className="mb-2 opacity-50" />
            <p className="text-xs">Open a folder to browse files</p>
          </div>
        )}
        {entries.map(entry => {
          const isActive = entry.path === currentFile;
          const isMedia = entry.is_audio || entry.is_video;

          if (entry.is_dir) {
            return (
              <button
                key={entry.path}
                onClick={() => onDirectoryChange(entry.path)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors group"
              >
                <Folder size={14} className="flex-none text-slate-500 group-hover:text-slate-300" />
                <span className="text-xs truncate">{entry.name}</span>
                <ChevronRight size={12} className="flex-none ml-auto opacity-0 group-hover:opacity-50" />
              </button>
            );
          }

          if (!isMedia) return null;

          return (
            <button
              key={entry.path}
              onClick={() => onFileSelect(entry.path)}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                isActive
                  ? 'bg-[#e65161]/20 text-[#e65161]'
                  : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              data-tooltip={entry.name}
            >
              {entry.is_audio
                ? <Music size={13} className="flex-none opacity-70" />
                : <Film size={13} className="flex-none opacity-70" />
              }
              <span className="text-xs truncate">{entry.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
