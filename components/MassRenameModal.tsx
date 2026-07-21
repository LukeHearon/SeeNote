import React, { useEffect, useState } from 'react';
import { massRenameModal as copy } from '../copy/ui';
import { Annotation } from '../types';
import { scanLabelOccurrences, IdentMatchCount } from '../utils/annotationRename';
import SettingsModalShell from './SettingsModalShell';

interface Props {
  annotations: Annotation[];
  allTracks: string[];
  trackPath: string | null;
  ident: string | null;
  getAnnotationPath: (trackFilePath: string) => string | null;
  getIdent: (trackFilePath: string) => string | null;
  onClose: () => void;
  // Applies the rename: current-track annotations in memory, every other
  // track's annotation file on disk. Resolves with the total renamed count.
  onApply: (oldText: string, newText: string) => Promise<number>;
}

export default function MassRenameModal({
  annotations, allTracks, trackPath, ident, getAnnotationPath, getIdent, onClose, onApply,
}: Props) {
  const [oldText, setOldText] = useState('');
  const [newText, setNewText] = useState('');
  const [matches, setMatches] = useState<IdentMatchCount[]>([]);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Debounced scan across every other track's on-disk annotation file, merged
  // with an in-memory count for the current track (which may not be flushed
  // to disk yet).
  useEffect(() => {
    const label = oldText.trim();
    if (!label) {
      setMatches([]);
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
        const currentCount = annotations.filter(a => a.text === label).length;
        const merged = currentCount > 0 && ident
          ? [...diskMatches, { ident, count: currentCount }].sort((a, b) => a.ident.localeCompare(b.ident))
          : diskMatches;
        setMatches(merged);
      } catch (err) {
        if (!cancelled) setError(`Scan failed: ${String(err)}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [oldText, allTracks, trackPath, annotations, ident, getAnnotationPath, getIdent]);

  const totalCount = matches.reduce((sum, m) => sum + m.count, 0);
  const canApply = totalCount > 0 && newText.trim().length > 0 && newText.trim() !== oldText.trim() && !applying && !scanning;

  const handleApply = async () => {
    setApplying(true);
    setError('');
    try {
      await onApply(oldText.trim(), newText.trim());
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

        <div>
          <label className="text-gray-400 text-sm block mb-1">{copy.breakdownHeading}</label>
          {scanning && <p className="text-gray-500 text-sm">{copy.scanningLabel}</p>}
          {!scanning && oldText.trim() && matches.length === 0 && (
            <p className="text-gray-500 text-sm">{copy.noMatchesLabel}</p>
          )}
          {!scanning && matches.length > 0 && (
            <div className="max-h-40 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700">
              {matches.map(m => (
                <div key={m.ident} className="flex items-start justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="text-gray-300 break-all">{m.ident}</span>
                  <span className="text-gray-500 flex-none">{m.count}</span>
                </div>
              ))}
            </div>
          )}
          {!scanning && matches.length > 0 && (
            <p className="text-gray-500 text-xs mt-1">{copy.totalCountLabel(totalCount, matches.length)}</p>
          )}
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </SettingsModalShell>
    </div>
  );
}
