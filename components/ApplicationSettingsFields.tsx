import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { projectSettingsModal } from '../copy/ui';
import { readAppSettings, writeAppSettings } from '../utils/projectCommands';
import { openFileDialog } from '../utils/tauriCommands';

/**
 * System-wide settings, stored in `{appDataDir}/app_settings.json` rather
 * than any project's `.seenote/` directory. Self-contained: loads on mount
 * and persists each change immediately, independent of the parent modal's
 * save/cancel flow (there's nothing project-specific here to validate).
 */
export default function ApplicationSettingsFields() {
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    readAppSettings()
      .then(s => setFfmpegPath(s.ffmpegPath ?? ''))
      .finally(() => setLoaded(true));
  }, []);

  const commit = (path: string) => {
    writeAppSettings({ ffmpegPath: path.trim() || undefined }).catch(() => {});
  };

  const handleBrowse = async () => {
    const picked = await openFileDialog(ffmpegPath || null, []);
    if (picked) {
      setFfmpegPath(picked);
      commit(picked);
    }
  };

  if (!loaded) return null;

  return (
    <div>
      <label className="text-gray-400 text-sm block mb-1">{projectSettingsModal.ffmpegPathLabel}</label>
      <p className="text-xs text-gray-500 mb-2">{projectSettingsModal.ffmpegPathHint}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={ffmpegPath}
          onChange={e => setFfmpegPath(e.target.value)}
          onBlur={() => commit(ffmpegPath)}
          placeholder={projectSettingsModal.ffmpegPathPlaceholder}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
        />
        <button
          type="button"
          onClick={handleBrowse}
          className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
          title="Browse"
        >
          <FolderOpen size={16} />
        </button>
      </div>
    </div>
  );
}
