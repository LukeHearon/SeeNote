import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { projectSettingsModal, applicationSettingsFields } from '../copy/ui';
import { loadAppSettings, updateAppSettings } from '../hooks/useAppSettings';
import { detectFfmpeg, openFileDialog, setFfmpegPath as pushFfmpegPath } from '../utils/tauriCommands';
import type { DateTimeFormat } from '../utils/datetimeDisplay';
import DateTimeFormatField from './DateTimeFormatField';
import AnnotatorNameField from './AnnotatorNameField';

interface Props {
  /** Values an open project stored before these settings went app-wide —
   *  shown until the user sets the app-wide ones. */
  legacyDateTimeFormat?: DateTimeFormat;
  legacyAnnotatorName?: string;
}

/**
 * System-wide settings, stored in `{appDataDir}/app_settings.json` rather
 * than any project's `.seenote/` directory. Self-contained: loads on mount
 * and persists each change immediately, independent of the parent modal's
 * save/cancel flow (there's nothing project-specific here to validate).
 */
export default function ApplicationSettingsFields({ legacyDateTimeFormat, legacyAnnotatorName }: Props) {
  const [ffmpegPath, setFfmpegPath] = useState('');
  /** True while the box is showing an auto-detected path rather than a value
   *  the user set. Such a value is displayed (so detection is visible) but not
   *  written to settings unless the user edits it — leaving the setting unset
   *  keeps detection live if ffmpeg later moves or is upgraded. */
  const [autoDetected, setAutoDetected] = useState(false);
  const [loaded, setLoaded] = useState(false);

  /** Ask the backend what it resolved, and show that when the user hasn't
   *  pinned a location themselves. Empty box = nothing found. */
  const showDetected = () =>
    detectFfmpeg()
      .then(found => {
        setFfmpegPath(found ?? '');
        setAutoDetected(!!found);
      })
      .catch(() => {});

  useEffect(() => {
    loadAppSettings()
      .then(async s => {
        const saved = s.ffmpegPath?.trim();
        if (saved) setFfmpegPath(saved);
        else await showDetected();
      })
      .finally(() => setLoaded(true));
  }, []);

  const commit = async (path: string) => {
    const trimmed = path.trim();
    setAutoDetected(false);
    await updateAppSettings(s => ({ ...s, ffmpegPath: trimmed || undefined }));
    await pushFfmpegPath(trimmed || null).catch(() => {});
    // Cleared the field? Fall back to showing whatever the search now finds.
    if (!trimmed) await showDetected();
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
    <>
      <AnnotatorNameField legacyName={legacyAnnotatorName} />

      <DateTimeFormatField legacyFormat={legacyDateTimeFormat} />

      <div>
        <label className="text-gray-400 text-sm block mb-1">{projectSettingsModal.ffmpegPathLabel}</label>
        <p className="text-xs text-gray-500 mb-2">{projectSettingsModal.ffmpegPathHint}</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={ffmpegPath}
            onChange={e => {
              setAutoDetected(false);
              setFfmpegPath(e.target.value);
            }}
            // Nothing to save when the box is just echoing what was detected.
            onBlur={() => { if (!autoDetected) commit(ffmpegPath); }}
            className={`flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm ${
              autoDetected ? 'text-gray-400 italic' : 'text-white'
            }`}
          />
          <button
            type="button"
            onClick={handleBrowse}
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
            title={applicationSettingsFields.browse}
          >
            <FolderOpen size={16} />
          </button>
        </div>
        {autoDetected && (
          <p className="text-xs text-gray-500 mt-1">{projectSettingsModal.ffmpegPathDetected}</p>
        )}
      </div>
    </>
  );
}
