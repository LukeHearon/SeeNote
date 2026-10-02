import React, { useState } from 'react';
import { FolderSearch, FolderOpen, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { RelinkInfo, RelinkResolution } from '../types';
import { launchScreen } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { browseDirectoryNear } from '../utils/dirDialogs';
import ConfirmDialog from './ConfirmDialog';

/**
 * Re-link confirmation: the directory health of the chosen folder (with a way
 * to locate any that are missing) and, when the on-disk name disagrees with
 * SeeNote's, a choice of which to keep.
 */
export default function RelinkDialog({ info, onResolve }: {
  info: RelinkInfo;
  onResolve: (r: RelinkResolution) => void;
}) {
  // When the on-disk name disagrees, the user readies one of the two names
  // before committing the re-link; null means no choice made yet.
  const [readyName, setReadyName] = useState<string | null>(null);
  // User-browsed paths for missing dirs, keyed by RelinkDirStatus.label.
  const [dirOverrides, setDirOverrides] = useState<Record<string, string>>({});

  const locate = async (label: string, currentPath: string) => {
    const dir = await browseDirectoryNear(currentPath);
    if (dir) setDirOverrides(prev => ({ ...prev, [label]: dir }));
  };

  const requiredDirs = info.dirs.filter(d => d.label !== 'buzzdetect');
  const allRequiredFound = requiredDirs.every(d => d.exists || !!dirOverrides[d.label]);
  const nameReady = !info.nameConflict || readyName !== null;
  const cancel = () => onResolve({ action: 'cancel' });

  const nameChoice = (name: string, tooltip: string) => (
    <button
      onClick={() => setReadyName(name)}
      className={
        'px-3 py-1 rounded-lg text-sm transition-colors ' +
        (readyName === name ? 'bg-blue-600 text-white ring-2 ring-blue-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200')
      }
      data-tooltip={tooltip}
    >
      "{name}"
    </button>
  );

  return (
    <ConfirmDialog
      title={launchScreen.relinkTitle}
      message={launchScreen.relinkMessage}
      icon={<FolderSearch size={20} className="text-blue-400" />}
      onDismiss={cancel}
      actions={[
        { label: launchScreen.cancelButton, onClick: cancel },
        {
          label: launchScreen.relinkButton,
          tone: 'primary',
          disabled: !(allRequiredFound && nameReady),
          onClick: () => onResolve({
            action: 'relink',
            name: info.nameConflict ? readyName! : info.settingsName,
            dirOverrides: Object.keys(dirOverrides).length ? dirOverrides : undefined,
          }),
        },
      ]}
    >
      <ul className="space-y-2 text-sm">
        {info.dirs.map(d => {
          const resolved = d.exists || !!dirOverrides[d.label];
          return (
            <li key={d.label} className="flex items-start gap-2">
              {resolved
                ? <CheckCircle2 size={16} className="text-emerald-400 flex-none mt-0.5" />
                : <AlertTriangle size={16} className="text-amber-400 flex-none mt-0.5" />}
              <span className="min-w-0">
                <span className="text-gray-200">{d.label}</span>{' '}
                <span className={resolved ? 'text-emerald-400' : 'text-amber-400'}>
                  {resolved ? launchScreen.statusFound : launchScreen.statusMissing}
                </span>
                <span className="block text-gray-500 text-xs break-words">{dirOverrides[d.label] ?? d.path}</span>
                {!d.exists && (
                  <button
                    onClick={() => locate(d.label, d.path)}
                    className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-md transition-colors"
                  >
                    <FolderOpen size={13} />
                    {launchScreen.locate}
                  </button>
                )}
              </span>
            </li>
          );
        })}

        {info.nameConflict && (
          <li className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {readyName !== null
                ? <CheckCircle2 size={16} className="text-emerald-400 flex-none" />
                : <AlertTriangle size={16} className="text-amber-400 flex-none" />}
              <span>
                <span className="text-gray-200">{launchScreen.nameLabel}</span>{' '}
                <span className={readyName !== null ? 'text-emerald-400' : 'text-amber-400'}>
                  {readyName !== null ? launchScreen.nameConflictSelected : launchScreen.nameConflictDiffers}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap gap-2 pl-6">
              {nameChoice(info.internalName, tooltips.keepSeeNoteName)}
              {nameChoice(info.settingsName, tooltips.useFolderName)}
            </div>
          </li>
        )}
      </ul>
    </ConfirmDialog>
  );
}
