import { getGitCredential, setGitCredential, deleteGitCredential } from './tauriCommands';
import type { GitSyncUserConfig } from '../types';

export type TokenStorage = 'keychain' | 'plaintext';

export function normalizeGitRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

/**
 * Read the PAT for a sync config, honoring its storage mode. For 'plaintext' the
 * token is read straight from preferences (no IPC, no Keychain password prompt);
 * for 'keychain' (the default) it comes from the OS credential store.
 *
 * Single source of truth for every token read — ProjectSettingsModal load and
 * AnnotationWindow sync/heartbeat all go through here so the mode branch lives
 * in exactly one place.
 *
 * `remoteUrl` is from GitSyncConfig (settings); the rest is from GitSyncUserConfig (preferences).
 */
export async function readSyncToken(
  remoteUrl: string,
  userCfg: Pick<GitSyncUserConfig, 'tokenStorage' | 'tokenPlaintext'>,
): Promise<string | null> {
  if (userCfg.tokenStorage === 'plaintext') return userCfg.tokenPlaintext ?? null;
  return getGitCredential(remoteUrl);
}

/**
 * Persist `token` under `remoteUrl` in the chosen storage and return the
 * GitSyncConfig fields to merge into settings.json. `token === null` clears it.
 *
 * Always clears the other store, so switching modes (or re-saving) never leaves
 * a stale copy: 'plaintext' deletes any Keychain entry and returns the token in
 * settings; 'keychain' writes/clears the OS entry and returns no plaintext.
 *
 * Caller must only invoke this with a definite token value — for the "leave the
 * existing token untouched" case, don't call it (a null here would erase a good
 * Keychain entry).
 */
export async function applySyncToken(
  remoteUrl: string,
  storage: TokenStorage,
  token: string | null,
): Promise<Pick<GitSyncUserConfig, 'tokenStorage' | 'tokenPlaintext'>> {
  if (storage === 'plaintext') {
    await deleteGitCredential(remoteUrl).catch(() => {});
    return { tokenStorage: 'plaintext', tokenPlaintext: token ?? undefined };
  }
  if (token) await setGitCredential(remoteUrl, token);
  else await deleteGitCredential(remoteUrl).catch(() => {});
  return { tokenStorage: 'keychain' };
}
