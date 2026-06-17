import React, { useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';
import GradientPicker from './GradientPicker';
import DirectoryField from './DirectoryField';
import CollapsibleSection from './CollapsibleSection';
import { openSyncGuideWindow } from '../utils/tauriCommands';
import { normalizeGitRemoteUrl } from '../utils/gitSync';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
const isWindows = /win/.test(ua);
const isMac = /mac/.test(ua);
// How the OS credential store behaves, so the keychain note matches the platform.
const keychainNote = isWindows
  ? 'Saved in Windows Credential Manager, never in settings.json.'
  : isMac
    ? 'Saved in your macOS Keychain, never in settings.json. Unsigned builds may prompt for your password when the token is read.'
    : 'Saved in your system keyring (Secret Service), never in settings.json. The keyring may prompt to unlock.';

interface Props {
  projectDir: string;
  // Name + gradient
  name: string;
  onNameInput: (name: string) => void;
  gradientColors: [string, string];
  onGradientChange: (colors: [string, string]) => void;
  // Directories
  mediaDir: string;
  onMediaDirChange: (v: string) => void;
  mediaDirPlaceholder?: string;
  mediaDirNotExistMessage: string;
  annotationDir: string;
  onAnnotationDirChange: (v: string) => void;
  annotationDirPlaceholder?: string;
  annotationDirNotExistMessage: string;
  // Output
  outputRoundingDecimals: number;
  onOutputRoundingDecimalsChange: (n: number) => void;
  // Advanced
  buzzdetectDir: string;
  onBuzzdetectDirChange: (v: string) => void;
  advancedDefaultOpen?: boolean;
  // Sync
  syncRemoteUrl: string;
  onSyncRemoteUrlChange: (v: string) => void;
  syncToken: string;
  onSyncTokenChange: (v: string) => void;
  syncTokenDirty?: boolean;
  syncTokenSavedLength?: number | null;
  syncTokenStorage?: 'keychain' | 'plaintext';
  onSyncTokenStorageChange?: (v: 'keychain' | 'plaintext') => void;
  syncAuthorName: string;
  onSyncAuthorNameChange: (v: string) => void;
  syncDefaultOpen?: boolean;
}

export default function ProjectBaseFields({
  projectDir,
  name,
  onNameInput,
  gradientColors,
  onGradientChange,
  mediaDir,
  onMediaDirChange,
  mediaDirPlaceholder,
  mediaDirNotExistMessage,
  annotationDir,
  onAnnotationDirChange,
  annotationDirPlaceholder,
  annotationDirNotExistMessage,
  outputRoundingDecimals,
  onOutputRoundingDecimalsChange,
  buzzdetectDir,
  onBuzzdetectDirChange,
  advancedDefaultOpen = false,
  syncRemoteUrl,
  onSyncRemoteUrlChange,
  syncToken,
  onSyncTokenChange,
  syncTokenDirty = true,
  syncTokenSavedLength = null,
  syncTokenStorage = 'keychain',
  onSyncTokenStorageChange,
  syncAuthorName,
  onSyncAuthorNameChange,
  syncDefaultOpen = false,
}: Props) {
  const nameRef = useRef<HTMLDivElement>(null);
  const displayedSyncToken =
    !syncTokenDirty && syncTokenSavedLength
      ? '•'.repeat(syncTokenSavedLength)
      : syncToken;

  // Sync contentEditable when name changes externally (e.g. auto-fill from projectDir).
  // The guard prevents interfering with the user's cursor while they're typing.
  useEffect(() => {
    const el = nameRef.current;
    if (el && el.textContent !== name) el.textContent = name;
  }, [name]);

  return (
    <>
      <div>
        <label className="text-gray-400 text-sm block mb-1">Project Name</label>
        <div className="border-b border-gray-600 focus-within:border-blue-500 pb-1">
          <div
            ref={nameRef}
            contentEditable
            suppressContentEditableWarning
            onInput={e => onNameInput((e.target as HTMLDivElement).textContent || '')}
            onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
            onPaste={e => {
              e.preventDefault();
              const text = e.clipboardData.getData('text/plain');
              const sel = window.getSelection();
              if (!sel || !sel.rangeCount) return;
              const range = sel.getRangeAt(0);
              range.deleteContents();
              range.insertNode(document.createTextNode(text));
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }}
            className="text-xl font-bold bg-clip-text text-transparent outline-none cursor-text"
            style={{
              backgroundImage: `linear-gradient(to right, ${gradientColors[0]}, ${gradientColors[1]})`,
              display: 'inline-block',
              minWidth: '2ch',
              caretColor: '#FFFFFF',
            }}
          />
        </div>
        <div className="mt-3">
          <GradientPicker value={gradientColors} onChange={onGradientChange} />
        </div>
      </div>

      <DirectoryField
        label="Media"
        projectDir={projectDir}
        value={mediaDir}
        onChange={onMediaDirChange}
        placeholder={mediaDirPlaceholder}
        notExistMessage={mediaDirNotExistMessage}
      />

      <DirectoryField
        label="Annotations"
        projectDir={projectDir}
        value={annotationDir}
        onChange={onAnnotationDirChange}
        placeholder={annotationDirPlaceholder}
        notExistMessage={annotationDirNotExistMessage}
      />

      <div>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-gray-400 text-sm block">Output Decimal Places</label>
            <p className="text-gray-600 text-xs">for start/end timestamps</p>
          </div>
          <input
            type="number"
            min="0"
            max="9"
            step="1"
            value={outputRoundingDecimals}
            onChange={e => {
              const v = parseInt(e.target.value);
              if (!isNaN(v)) onOutputRoundingDecimalsChange(Math.min(9, Math.max(0, v)));
            }}
            className="w-16 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <CollapsibleSection title="Advanced" defaultOpen={advancedDefaultOpen}>
        <DirectoryField
          label="buzzdetect"
          projectDir={projectDir}
          value={buzzdetectDir}
          onChange={onBuzzdetectDirChange}
          placeholder="(optional) directory of {ident}_buzzdetect.csv"
          helperText="Activations plotted below the spectrogram, located per track by ident."
          notExistMessage="Directory does not exist."
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Sync (GitHub)"
        defaultOpen={syncDefaultOpen}
        headerAction={
          <button
            type="button"
            onClick={openSyncGuideWindow}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            data-tooltip="How to set up a synced project"
          >
            <HelpCircle size={14} />
          </button>
        }
      >
        <p className="text-gray-500 text-xs mb-3">
          Sync annotations to a shared private repo. Media, tool example clips, and
          these settings are never uploaded to the repo. Your name is recorded as the
          author of your annotation edits. Your name is optional.
        </p>
        <div>
          <label className="text-gray-400 text-sm block mb-1">Repository URL</label>
          <input
            type="text"
            value={syncRemoteUrl}
            onChange={e => onSyncRemoteUrlChange(e.target.value)}
            onBlur={() => {
              const normalized = normalizeGitRemoteUrl(syncRemoteUrl);
              if (normalized !== syncRemoteUrl) onSyncRemoteUrlChange(normalized);
            }}
            placeholder="https://github.com/your-lab/annotations.git"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="mt-3">
          <label className="text-gray-400 text-sm block mb-1">Access token</label>
          <input
            type="password"
            value={displayedSyncToken}
            onChange={e => onSyncTokenChange(e.target.value)}
            onFocus={e => {
              if (!syncTokenDirty && syncTokenSavedLength) e.currentTarget.select();
            }}
            onMouseUp={e => {
              // Prevent cursor positioning within the spoofed bullets — keep all selected.
              if (!syncTokenDirty && syncTokenSavedLength) e.currentTarget.select();
            }}
            onKeyDown={e => {
              // Block cursor-movement keys in spoofed mode so the field acts as an
              // atomic placeholder rather than an editable string.
              if (!syncTokenDirty && syncTokenSavedLength) {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) e.preventDefault();
              }
            }}
            placeholder="fine-grained PAT (github_pat_…)"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          {syncTokenDirty && syncToken && !syncToken.startsWith('github_pat_') && (
            <p className="text-yellow-500 text-xs mt-1">Token doesn't look like a GitHub fine-grained PAT (expected prefix: github_pat_)</p>
          )}
        </div>
        <div className="mt-3">
          <label className="text-gray-400 text-sm block mb-1">Token storage</label>
          <div className="flex gap-1 bg-gray-800 border border-gray-600 rounded-lg p-0.5">
            {([
              ['keychain', 'OS keychain'],
              ['plaintext', 'Plaintext'],
            ] as const).map(([mode, title]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onSyncTokenStorageChange?.(mode)}
                className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
                  syncTokenStorage === mode
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {title}
              </button>
            ))}
          </div>
          <div className="flex gap-1 mt-1 px-0.5">
            <span className="flex-1 text-center text-[10px] text-gray-600">Recommended</span>
            <span className="flex-1 text-center text-[10px] text-gray-600">No password prompts</span>
          </div>
          {syncTokenStorage === 'plaintext' ? (
            <p className="text-yellow-500/90 text-xs mt-2 border border-yellow-700/50 bg-yellow-950/30 rounded-lg px-3 py-2">
              <span className="text-yellow-400 font-medium">Stored unencrypted</span> in this project's
              settings.json on this machine. It is never pushed to the repo, but anything that can read
              your files can read the token. If it leaks, revoke it on GitHub.
            </p>
          ) : (
            <p className="text-gray-500 text-xs mt-2">{keychainNote}</p>
          )}
        </div>
        <div className="mt-3">
          <label className="text-gray-400 text-sm block mb-1">Your name <span className="text-gray-600">(optional)</span></label>
          <input
            type="text"
            value={syncAuthorName}
            onChange={e => onSyncAuthorNameChange(e.target.value)}
            placeholder="recorded as the author of your annotation edits"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </CollapsibleSection>
    </>
  );
}
