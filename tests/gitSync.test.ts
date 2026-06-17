import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { normalizeGitRemoteUrl, readSyncToken } from '../utils/gitSync';

const mockInvoke = vi.mocked(invoke);

describe('normalizeGitRemoteUrl', () => {
  it('trims, removes trailing slashes, and appends .git', () => {
    expect(normalizeGitRemoteUrl(' https://github.com/lab/annotations/ ')).toBe(
      'https://github.com/lab/annotations.git',
    );
  });

  it('leaves existing .git suffixes alone', () => {
    expect(normalizeGitRemoteUrl('https://github.com/lab/annotations.git')).toBe(
      'https://github.com/lab/annotations.git',
    );
  });

  it('keeps blank values blank', () => {
    expect(normalizeGitRemoteUrl('   ')).toBe('');
  });
});

describe('readSyncToken', () => {
  it('reads a plaintext token from the config without touching the keychain', async () => {
    mockInvoke.mockClear();
    const token = await readSyncToken({
      remoteUrl: 'https://github.com/lab/annotations.git',
      tokenStorage: 'plaintext',
      tokenPlaintext: 'github_pat_abc',
    });
    expect(token).toBe('github_pat_abc');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('returns null for plaintext mode with no stored token', async () => {
    mockInvoke.mockClear();
    const token = await readSyncToken({
      remoteUrl: 'https://github.com/lab/annotations.git',
      tokenStorage: 'plaintext',
    });
    expect(token).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('falls back to the OS credential store when mode is keychain (or unset)', async () => {
    mockInvoke.mockResolvedValueOnce('github_pat_from_keychain');
    const token = await readSyncToken({
      remoteUrl: 'https://github.com/lab/annotations.git',
    });
    expect(token).toBe('github_pat_from_keychain');
    expect(mockInvoke).toHaveBeenCalledWith('get_git_credential', {
      remoteUrl: 'https://github.com/lab/annotations.git',
    });
  });
});
