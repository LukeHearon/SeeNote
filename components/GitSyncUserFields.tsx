import React from 'react';
import { gitSyncUserFields } from '../copy/ui';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
const isWindows = /win/.test(ua);
const isMac = /mac/.test(ua);

export interface GitSyncUserFieldsProps {
  syncToken: string;
  onSyncTokenChange: (v: string) => void;
  syncTokenDirty?: boolean;
  syncTokenSavedLength?: number | null;
  syncTokenStorage?: 'keychain' | 'plaintext';
  onSyncTokenStorageChange?: (v: 'keychain' | 'plaintext') => void;
  syncAuthorName: string;
  onSyncAuthorNameChange: (v: string) => void;
  autoFocusToken?: boolean;
}

export default function GitSyncUserFields({
  syncToken,
  onSyncTokenChange,
  syncTokenDirty = true,
  syncTokenSavedLength = null,
  syncTokenStorage = 'keychain',
  onSyncTokenStorageChange,
  syncAuthorName,
  onSyncAuthorNameChange,
  autoFocusToken = false,
}: GitSyncUserFieldsProps) {
  const displayedSyncToken =
    !syncTokenDirty && syncTokenSavedLength
      ? '•'.repeat(syncTokenSavedLength)
      : syncToken;

  return (
    <>
      <div>
        <label className="text-gray-400 text-sm block mb-1">{gitSyncUserFields.tokenLabel}</label>
        <input
          type="password"
          autoFocus={autoFocusToken}
          value={displayedSyncToken}
          onChange={e => onSyncTokenChange(e.target.value)}
          onFocus={e => {
            if (!syncTokenDirty && syncTokenSavedLength) e.currentTarget.select();
          }}
          onMouseUp={e => {
            if (!syncTokenDirty && syncTokenSavedLength) e.currentTarget.select();
          }}
          onKeyDown={e => {
            if (!syncTokenDirty && syncTokenSavedLength) {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) e.preventDefault();
            }
          }}
          placeholder={gitSyncUserFields.tokenPlaceholder}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        />
        {syncTokenDirty && syncToken && !syncToken.startsWith('github_pat_') && (
          <p className="text-yellow-500 text-xs mt-1">
            {gitSyncUserFields.patFormatWarning}
          </p>
        )}
      </div>
      <div className="mt-3">
        <label className="text-gray-400 text-sm block mb-1">{gitSyncUserFields.tokenStorageLabel}</label>
        <div className="flex gap-1 bg-gray-800 border border-gray-600 rounded-lg p-0.5">
          {([
            ['keychain', gitSyncUserFields.keychainOption],
            ['plaintext', gitSyncUserFields.plaintextOption],
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
        {syncTokenStorage === 'plaintext' ? (
          <p className="text-yellow-500/90 text-xs mt-2 border border-yellow-700/50 bg-yellow-950/30 rounded-lg px-3 py-2">
            <span className="text-yellow-400 font-medium">{gitSyncUserFields.storedUnencryptedHint}</span>{' '}
            {gitSyncUserFields.storedUnencryptedDetail}
          </p>
        ) : (
          <p className="text-gray-500 text-xs mt-2">
            {isWindows ? gitSyncUserFields.keychainNoteWindows : isMac ? gitSyncUserFields.keychainNoteMac : gitSyncUserFields.keychainNoteLinux}
          </p>
        )}
      </div>
      <div className="mt-3">
        <label className="text-gray-400 text-sm block mb-1">
          {gitSyncUserFields.nameLabel}
        </label>
        <input
          type="text"
          value={syncAuthorName}
          onChange={e => onSyncAuthorNameChange(e.target.value)}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
    </>
  );
}
