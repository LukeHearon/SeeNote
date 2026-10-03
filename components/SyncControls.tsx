import { useState } from 'react';
import { ChevronDown, Github, RefreshCw } from 'lucide-react';
import ContextMenu from './ContextMenu';
import { tooltips } from '../copy/tooltips';
import { annotationWindow } from '../copy/ui';
import { githubRepoPageUrl } from '../utils/gitSync';
import { openGithubUrl } from '../utils/tauriCommands';

interface Props {
  remoteUrl: string;
  syncing: boolean;
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
  /** Sync now, with an optional custom commit message. */
  onSync: (message?: string) => void;
}

function openRepoPage(remoteUrl: string) {
  const url = githubRepoPageUrl(remoteUrl);
  if (url) openGithubUrl(url).catch(err => console.error('Failed to open GitHub repo:', err));
}

/**
 * The header's sync button: click to sync, the chevron for a custom commit
 * message, right-click for the repo page. Dots mark unpushed (left) and
 * unpulled (right) changes.
 */
export default function SyncControls({ remoteUrl, syncing, hasLocalChanges, hasRemoteChanges, onSync }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const repoPage = githubRepoPageUrl(remoteUrl);

  const syncWithMessage = () => {
    setMenuOpen(false);
    onSync(commitMessage);
    setCommitMessage('');
  };

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => onSync()}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        disabled={syncing}
        className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-50 disabled:cursor-default relative"
        data-tooltip={
          syncing ? tooltips.syncing
          : hasLocalChanges && hasRemoteChanges ? `${tooltips.syncUnpushed} · ${tooltips.syncUnpulled}`
          : hasLocalChanges ? tooltips.syncUnpushed
          : hasRemoteChanges ? tooltips.syncUnpulled
          : tooltips.syncIdle
        }
      >
        <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
        {hasLocalChanges && !syncing && (
          <span className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-green-400/80 pointer-events-none" />
        )}
        {hasRemoteChanges && !syncing && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400/80 pointer-events-none" />
        )}
      </button>
      <button
        onClick={() => setMenuOpen(o => !o)}
        disabled={syncing}
        className={`p-1 rounded hover:bg-slate-700 hover:text-white disabled:opacity-50 disabled:cursor-default ${menuOpen ? 'text-white bg-slate-700' : 'text-slate-400'}`}
        data-tooltip={tooltips.syncWithMessage}
      >
        <ChevronDown size={14} />
      </button>
      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 z-[300] w-72 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-3">
          <label className="block text-xs font-medium text-slate-300 mb-1.5">{annotationWindow.commitLabel}</label>
          <textarea
            autoFocus
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                syncWithMessage();
              } else if (e.key === 'Escape') {
                setMenuOpen(false);
              }
            }}
            rows={2}
            placeholder={annotationWindow.commitPlaceholder}
            className="w-full text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-slate-100 placeholder-slate-500 resize-none focus:outline-none focus:border-[#e65161]"
          />
          {repoPage && (
            <button
              onClick={() => { setMenuOpen(false); openRepoPage(remoteUrl); }}
              className="flex items-center gap-1.5 mt-2 text-xs text-slate-300 hover:text-white transition-colors"
            >
              <Github size={13} />
              {annotationWindow.viewGithubRepo}
            </button>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={() => setMenuOpen(false)}
              className="text-xs px-2.5 py-1 rounded text-slate-300 hover:bg-slate-700"
            >
              {annotationWindow.syncMenuCancel}
            </button>
            <button
              onClick={syncWithMessage}
              className="text-xs px-2.5 py-1 rounded bg-[#e65161] text-white hover:bg-[#d63d4e]"
            >
              {annotationWindow.syncMenuConfirm}
            </button>
          </div>
        </div>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[{
            label: annotationWindow.viewGithubRepo,
            icon: <Github size={13} />,
            disabled: !repoPage,
            onSelect: () => openRepoPage(remoteUrl),
          }]}
        />
      )}
    </div>
  );
}
