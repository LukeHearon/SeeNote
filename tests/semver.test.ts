import { describe, it, expect } from 'vitest';
import { versionBumpType } from '../utils/semver';

describe('versionBumpType', () => {
  it('detects a major bump', () => {
    expect(versionBumpType('1.2.3', '2.0.0')).toBe('major');
  });

  it('detects a minor bump', () => {
    expect(versionBumpType('1.2.3', '1.3.0')).toBe('minor');
  });

  it('detects a patch bump', () => {
    expect(versionBumpType('1.2.3', '1.2.4')).toBe('patch');
  });

  it('falls back to patch on unparseable versions', () => {
    expect(versionBumpType('1.2', '1.2.3')).toBe('patch');
  });
});
