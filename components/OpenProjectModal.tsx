import React, { useEffect, useState } from 'react';
import { FolderOpen, Archive, Loader2, AlertCircle } from 'lucide-react';
import { Project } from '../types';
import { openFileDialog, openDirectoryDialog, checkDirExists, peekArchiveExtractPath, extractArchive } from '../utils/tauriCommands';
import { basename } from '../utils/projectPaths';
import { openProjectModal } from '../copy/ui';
import SettingsModalShell from './SettingsModalShell';

interface Props {
  onClose: () => void;
  /** Runs the existing "choose a folder, register it" flow (see LaunchScreen's
   * handleOpenExisting) and closes this modal. Kept in the caller rather than
   * duplicated here since it's identical logic. */
  onOpenFolder: () => void;
  addExistingProject: (projectDir: string) => Promise<Project>;
  onOpenProject: (project: Project) => void;
}

const ARCHIVE_EXTENSIONS = ['zip', 'tar', 'gz', 'tgz'];

export default function OpenProjectModal({ onClose, onOpenFolder, addExistingProject, onOpenProject }: Props) {
  const [activeTab, setActiveTab] = useState<'folder' | 'archive'>('folder');
  const [archivePath, setArchivePath] = useState('');
  const [destDir, setDestDir] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [destExists, setDestExists] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recompute the "Will extract to: ..." preview whenever either input
  // changes. Only Rust knows the archive's internal layout (a single wrapping
  // folder vs. loose entries), so this always asks it rather than guessing.
  useEffect(() => {
    if (!archivePath || !destDir) { setPreview(null); setDestExists(false); return; }
    let cancelled = false;
    setError(null);
    peekArchiveExtractPath(archivePath, destDir)
      .then(async path => {
        if (cancelled) return;
        setPreview(path);
        setDestExists(await checkDirExists(path));
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [archivePath, destDir]);

  const handleBrowseArchive = async () => {
    const path = await openFileDialog(null, [{ name: 'Archive', extensions: ARCHIVE_EXTENSIONS }]);
    if (path) setArchivePath(path);
  };

  const handleBrowseDest = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setDestDir(dir);
  };

  const handleExtract = async () => {
    if (!archivePath || !destDir) return;
    setExtracting(true);
    setError(null);
    try {
      const finalDir = await extractArchive(archivePath, destDir);
      const project = await addExistingProject(finalDir);
      onOpenProject(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setExtracting(false);
    }
  };

  const canExtract = !!archivePath && !!destDir && !!preview && !destExists && !extracting;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <SettingsModalShell
        title={openProjectModal.title}
        onClose={onClose}
        tabs={[
          { label: openProjectModal.tabFolder, active: activeTab === 'folder', onClick: () => setActiveTab('folder') },
          { label: openProjectModal.tabArchive, active: activeTab === 'archive', onClick: () => setActiveTab('archive') },
        ]}
        footer={
          activeTab === 'folder' ? (
            <button
              onClick={onOpenFolder}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors flex items-center gap-2"
            >
              <FolderOpen size={15} />
              {openProjectModal.chooseFolderButton}
            </button>
          ) : (
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
          )
        }
      >
        {activeTab === 'folder' ? (
          <p className="text-gray-400 text-sm">{openProjectModal.folderPrompt}</p>
        ) : (
          <>
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

            {preview && (
              <p className={destExists ? 'text-yellow-400 text-xs' : 'text-gray-500 text-xs'}>
                {destExists ? openProjectModal.destinationExists(preview) : openProjectModal.willExtractTo(preview)}
              </p>
            )}

            {error && (
              <div className="flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-xs">
                <AlertCircle size={14} className="flex-none mt-0.5" />
                <span className="font-mono">{error}</span>
              </div>
            )}
          </>
        )}
      </SettingsModalShell>
    </div>
  );
}
