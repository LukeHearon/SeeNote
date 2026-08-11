import React, { useEffect, useMemo, useState } from 'react';
import { massRenameModal as copy } from '../copy/ui';
import { Annotation } from '../types';
import { formatTime } from '../utils/helpers';
import { scanLabelOccurrences, IdentMatchCount, LabelMatch } from '../utils/annotationRename';
import SettingsModalShell from './SettingsModalShell';

interface Props {
  annotations: Annotation[];
  allTracks: string[];
  trackPath: string | null;
  ident: string | null;
  getAnnotationPath: (trackFilePath: string) => string | null;
  getIdent: (trackFilePath: string) => string | null;
  onClose: () => void;
  // Applies the rename: current-track annotations in memory, and — when
  // scope is 'project' — every other track's annotation file on disk.
  // Resolves with the total renamed count.
  onApply: (oldText: string, newText: string, scope: MassRenameScope) => Promise<number>;
}

export type MassRenameScope = 'track' | 'project';

export default function MassRenameModal({
  annotations, allTracks, trackPath, ident, getAnnotationPath, getIdent, onClose, onApply,
}: Props) {
  const [oldText, setOldText] = useState('');
  const [newText, setNewText] = useState('');
  const [scope, setScope] = useState<MassRenameScope>('track');
  const [projectMatches, setProjectMatches] = useState<IdentMatchCount[]>([]);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Current track's own occurrences, kept in memory — cheap to recompute on
  // every keystroke, no debounce needed. Used directly in 'track' scope, and
  // merged into the project-wide breakdown in 'project' scope.
  const trackMatches: LabelMatch[] = useMemo(() => {
    const label = oldText.trim();
    if (!label) return [];
    return annotations
      .filter(a => a.text === label)
      .map(a => ({ start: a.start, end: a.end, label: a.text }))
      .sort((a, b) => a.start - b.start);
  }, [oldText, annotations]);

  // Debounced scan across every other track's on-disk annotation file, only
  // needed in 'project' scope.
  useEffect(() => {
    const label = oldText.trim();
    if (!label || scope !== 'project') {
      setProjectMatches([]);
      setScanning(false);
      return;
    }
    setScanning(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const otherTracks = allTracks.filter(t => t !== trackPath);
        const diskMatches = await scanLabelOccurrences(otherTracks, getAnnotationPath, getIdent, label);
        if (cancelled) return;
        const merged = trackMatches.length > 0 && ident
          ? [...diskMatches, { ident, count: trackMatches.length }].sort((a, b) => a.ident.localeCompare(b.ident))
          : diskMatches;
        setProjectMatches(merged);
      } catch (err) {
        if (!cancelled) setError(`Scan failed: ${String(err)}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [oldText, scope, allTracks, trackPath, trackMatches, ident, getAnnotationPath, getIdent]);

  const totalCount = scope === 'track'
    ? trackMatches.length
    : projectMatches.reduce((sum, m) => sum + m.count, 0);
  const canApply = totalCount > 0 && newText.trim().length > 0 && newText.trim() !== oldText.trim() && !applying && !scanning;

  const handleApply = async () => {
    setApplying(true);
    setError('');
    try {
      await onApply(oldText.trim(), newText.trim(), scope);
      onClose();
    } catch (err) {
      setError(`Rename failed: ${String(err)}`);
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <SettingsModalShell
        title={copy.title}
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
              {copy.cancelButton}
            </button>
            <button
              onClick={handleApply}
              disabled={!canApply}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {applying ? copy.renamingButton : copy.renameButton}
            </button>
          </>
        }
      >
        <div>
          <label className="text-gray-400 text-sm block mb-1">{copy.oldLabelField}</label>
          <input
            type="text"
            autoFocus
            value={oldText}
            onChange={e => setOldText(e.target.value)}
            placeholder={copy.oldLabelPlaceholder}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="text-gray-400 text-sm block mb-1">{copy.newLabelField}</label>
          <input
            type="text"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            placeholder={copy.newLabelPlaceholder}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-4">
          {(['track', 'project'] as MassRenameScope[]).map(s => (
            <label key={s} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="radio"
                name="massRenameScope"
                checked={scope === s}
                onChange={() => setScope(s)}
                className="accent-blue-500"
              />
              <span className="text-sm text-gray-200">
                {s === 'track' ? copy.scopeCurrentTrackLabel : copy.scopeWholeProjectLabel}
              </span>
            </label>
          ))}
        </div>

        {scope === 'track' ? (
          <div>
            <label className="text-gray-400 text-sm block mb-1">{copy.occurrencesHeading}</label>
            {oldText.trim() && trackMatches.length === 0 && (
              <p className="text-gray-500 text-sm">{copy.noMatchesLabel}</p>
            )}
            {trackMatches.length > 0 && (
              <div className="max-h-40 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700">
                {trackMatches.map((m, i) => (
                  <div key={i} className="px-3 py-1.5 text-sm text-gray-300">
                    {formatTime(m.start)} – {formatTime(m.end)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="text-gray-400 text-sm block mb-1">{copy.breakdownHeading}</label>
            {scanning && <p className="text-gray-500 text-sm">{copy.scanningLabel}</p>}
            {!scanning && oldText.trim() && projectMatches.length === 0 && (
              <p className="text-gray-500 text-sm">{copy.noMatchesLabel}</p>
            )}
            {!scanning && projectMatches.length > 0 && (
              <div className="max-h-40 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700">
                {projectMatches.map(m => (
                  <div key={m.ident} className="flex items-start justify-between gap-2 px-3 py-1.5 text-sm">
                    <span className="text-gray-300 break-all">{m.ident}</span>
                    <span className="text-gray-500 flex-none">{m.count}</span>
                  </div>
                ))}
              </div>
            )}
            {!scanning && projectMatches.length > 0 && (
              <p className="text-gray-500 text-xs mt-1">{copy.totalCountLabel(totalCount, projectMatches.length)}</p>
            )}
          </div>
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </SettingsModalShell>
    </div>
  );
}
