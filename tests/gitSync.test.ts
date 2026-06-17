import { describe, expect, it } from 'vitest';
import { normalizeGitRemoteUrl } from '../utils/gitSync';

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
