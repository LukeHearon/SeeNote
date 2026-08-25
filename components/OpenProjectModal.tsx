import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, Archive, Loader2, AlertCircle } from 'lucide-react';
import { Project } from '../types';
import { openFileDialog, openDirectoryDialog, checkDirExists, guessProjectFolderName, extractArchive } from '../utils/tauriCommands';
import { basename, joinPath } from '../utils/projectPaths';
import { openProjectModal } from '../copy/ui';
import SettingsModalShell from './SettingsModalShell';

interface Props {
  onClose: () => void;
  addExistingProject: (projectDir: string) => Promise<Project>;
  onOpenProject: (project: Project) => void;
}

const ARCHIVE_EXTENSIONS = ['zip', 'tar', 'gz', 'tgz'];

/** "Open Project > From Archive" — pick an archive and a destination, review
 * (and optionally rename) the project folder name, then extract and open it.
 * Reached from the dropdown on LaunchScreen's "Open Project" button; "From
 * Folder" in that dropdown skips this modal entirely and goes straight to the
 * folder dialog. */
export default function OpenProjectModal({ onClose, addExistingProject, onOpenProject }: Props) {
  const [archivePath, setArchivePath] = useState('');
  const [destDir, setDestDir] = useState('');
  const [folderName, setFolderName] = useState('');
  const [destExists, setDestExists] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only auto-fill the name from the archive until the user edits it themselves.
  const nameTouchedRef = useRef(false);

  const handleBrowseArchive = async () => {
    const path = await openFileDialog(null, [{ name: 'Archive', extensions: ARCHIVE_EXTENSIONS }]);
    if (!path) return;
    setArchivePath(path);
    if (!nameTouchedRef.current) {
      try {
        setFolderName(await guessProjectFolderName(path));
      } catch {
        setFolderName(basename(path).replace(/\.(zip|tar|tar\.gz|tgz)$/i, ''));
      }
    }
  };

  const handleBrowseDest = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setDestDir(dir);
  };

  const preview = destDir && folderName ? joinPath(destDir, folderName) : null;

  // Warn when the chosen name collides with something already at the destination.
  useEffect(() => {
    if (!preview) { setDestExists(false); return; }
    let cancelled = false;
    checkDirExists(preview).then(exists => { if (!cancelled) setDestExists(exists); });
    return () => { cancelled = true; };
  }, [preview]);

  const handleExtract = async () => {
    if (!archivePath || !destDir || !folderName) return;
    setExtracting(true);
    setError(null);
    try {
      const finalDir = await extractArchive(archivePath, destDir, folderName);
      const project = await addExistingProject(finalDir);
      onOpenProject(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setExtracting(false);
    }
  };

  const canExtract = !!archivePath && !!destDir && !!folderName && !destExists && !extracting;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <SettingsModalShell
        title={openProjectModal.title}
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
              {openProjectModal.cancelButton}
            </button>
            <button
              onClick={handleExtract}
              disabled={!canExtract}
              className={
                canExtract
                  ? 'px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors flex items-center gap-2'
                  : 'px-4 py-2 bg-gray-700 text-gray-500 rounded-lg text-sm cursor-not-allowed flex items-center gap-2'
              }
            >
              {extracting && <Loader2 size={15} className="animate-spin" />}
              {extracting ? openProjectModal.extractingButton : openProjectModal.extractButton}
            </button>
          </>
        }
      >
        <div>
          <label className="text-gray-400 text-sm block mb-1">{openProjectModal.archiveLabel}</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={archivePath}
              placeholder={openProjectModal.archivePlaceholder}
              className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600"
            />
            <button
              onClick={handleBrowseArchive}
              className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
            >
              <Archive size={16} />
            </button>
          </div>
          {archivePath && <p className="text-gray-600 text-xs mt-1 truncate">{basename(archivePath)}</p>}
        </div>

        <div>
          <label className="text-gray-400 text-sm block mb-1">{openProjectModal.destinationLabel}</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={destDir}
              placeholder={openProjectModal.destinationPlaceholder}
              className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600"
            />
            <button
              onClick={handleBrowseDest}
              className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </div>

        <div>
          <label className="text-gray-400 text-sm block mb-1">{openProjectModal.folderNameLabel}</label>
          <input
            type="text"
            value={folderName}
            onChange={e => { nameTouchedRef.current = true; setFolderName(e.target.value); }}
            placeholder={openProjectModal.folderNamePlaceholder}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
        </div>

        {preview && (
          <p className={destExists ? 'text-yellow-400 text-xs' : 'text-gray-500 text-xs'}>
            {destExists ? openProjectModal.destinationExists(preview) : openProjectModal.projectLocation(preview)}
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-xs">
            <AlertCircle size={14} className="flex-none mt-0.5" />
            <span className="font-mono">{error}</span>
          </div>
        )}
      </SettingsModalShell>
    </div>
  );
}
