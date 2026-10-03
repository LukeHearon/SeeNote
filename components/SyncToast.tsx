import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { annotationWindow } from '../copy/ui';
import type { SyncSummary } from '../utils/tauriCommands';
import { INCOMING_CLEARS_PREFIX } from '../hooks/useSyncManagement';

interface Props {
  summary: SyncSummary | null;
  error: string | null;
  isAutoPull: boolean;
  /** Clears both the summary and the error. */
  onClose: () => void;
  onCommitClears: (idents: string[]) => void;
}

const AUTH_FAILED = 'AUTH_FAILED:';

/**
 * The post-sync summary / error toast (manual sync or background auto-pull).
 * Non-blocking; fades out and clears itself a few seconds after it appears —
 * except when it is asking whether to commit cleared tracks.
 */
export default function SyncToast({ summary, error, isAutoPull, onClose, onCommitClears }: Props) {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!summary && !error) return;
    setFading(false);
    // A toast asking whether to commit cleared tracks must not fade out from
    // under the user — it is the only thing standing between an accidentally
    // emptied track and everyone else losing those records.
    if (summary && summary.pendingClears.length > 0) return;
    const fadeTimer = setTimeout(() => setFading(true), 4500);
    const clearTimer = setTimeout(onClose, 5000);
    return () => { clearTimeout(fadeTimer); clearTimeout(clearTimer); };
    // onClose is a fresh closure each render; the timers belong to this toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, error]);

  if (!summary && !error) return null;

  const title = error
    ? (error.includes(AUTH_FAILED) ? annotationWindow.syncFailedAuth
      : error.includes(INCOMING_CLEARS_PREFIX) ? annotationWindow.autoPullBlocked
      : annotationWindow.syncFailed)
    : isAutoPull ? annotationWindow.autoPullComplete : annotationWindow.syncComplete;

  return (
    <div className={`fixed top-20 right-4 z-[300] w-80 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-4 transition-opacity duration-500 ${fading ? 'opacity-0' : 'opacity-100'}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-white">
          <X size={16} />
        </button>
      </div>
      {error ? (
        <p className="text-xs text-red-400 mt-2 whitespace-pre-wrap">
          {error.replace(AUTH_FAILED, '').replace(INCOMING_CLEARS_PREFIX, '').trim()}
        </p>
      ) : summary && (
        <div className="text-xs text-slate-300 mt-2 space-y-1">
          <p>{summary.message}</p>
          {summary.pendingClears.length > 0 && (
            <div className="mt-2 p-2 rounded border border-amber-600/60 bg-amber-950/30 space-y-2">
              <p className="text-amber-200">{annotationWindow.pendingClearsPrompt}</p>
              <ul className="max-h-32 overflow-y-auto space-y-0.5">
                {summary.pendingClears.map(id => (
                  <li key={id} className="font-mono text-[10px] text-amber-100/80 truncate">{id}</li>
                ))}
              </ul>
              <p className="text-amber-200">{annotationWindow.pendingClearsQuestion}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => { const ids = summary.pendingClears; onClose(); onCommitClears(ids); }}
                  className="px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white text-xs"
                >
                  {annotationWindow.pendingClearsCommit}
                </button>
                <button
                  onClick={onClose}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs"
                >
                  {annotationWindow.pendingClearsKeep}
                </button>
              </div>
            </div>
          )}
          {summary.identsUploaded > 0 && (
            <p>
              {annotationWindow.syncUploaded} <span className="text-green-400">+{summary.annotationsUploaded}</span>,{' '}
              <span className="text-red-400">−{summary.annotationsRemovedOnPush}</span>
              {annotationWindow.syncTallySuffix(!(summary.annotationsUploaded === 1 && summary.annotationsRemovedOnPush === 0), summary.identsUploaded)}
            </p>
          )}
          {(summary.annotationsAdded > 0 || summary.annotationsRemoved > 0) && (
            <p>
              {annotationWindow.syncDownloaded} <span className="text-green-400">+{summary.annotationsAdded}</span>,{' '}
              <span className="text-red-400">−{summary.annotationsRemoved}</span>
              {annotationWindow.syncTallySuffix(true, summary.recordingsChanged.length)}
            </p>
          )}
          {summary.recordingsChanged.length > 0 && (
            <ul className="max-h-32 overflow-y-auto mt-1 space-y-0.5">
              {summary.recordingsChanged.map(p => (
                <li key={p} className="font-mono text-[10px] text-slate-400 truncate">{p}</li>
              ))}
            </ul>
          )}
          {([
            [summary.remoteClears, annotationWindow.remoteClearsApplied],
            [summary.ignoredRemoteDeletions, annotationWindow.remoteDeletionsKept],
          ] as const).map(([paths, label]) => paths.length > 0 && (
            <div key={label} className="mt-2">
              <p className="text-amber-200">{label}</p>
              <ul className="max-h-24 overflow-y-auto space-y-0.5">
                {paths.map(p => <li key={p} className="font-mono text-[10px] text-amber-100/80 truncate">{p}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
