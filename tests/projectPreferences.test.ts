import { describe, it, expect } from 'vitest';
import { applyPreferencesPatch, preferencesPatch } from '../utils/projectPreferences';
import type { ProjectPreferences } from '../types';

describe('applyPreferencesPatch', () => {
  it('overrides only the patched keys', () => {
    const latest: ProjectPreferences = { fileFilter: 'annotated', shuffleMode: true };
    expect(applyPreferencesPatch(latest, { shuffleMode: false })).toEqual({ fileFilter: 'annotated', shuffleMode: false });
  });

  it('two patches applied in turn keep each other\'s keys', () => {
    let p: ProjectPreferences = {};
    p = applyPreferencesPatch(p, { bandPassFilter: null });
    p = applyPreferencesPatch(p, { fileFilter: 'all' });
    expect(p).toEqual({ bandPassFilter: null, fileFilter: 'all' });
  });

  it('merges uiSettings one level deep', () => {
    const latest = { uiSettings: { volume: 1, zoomSec: 30 } } as ProjectPreferences;
    const out = applyPreferencesPatch(latest, { uiSettings: { zoomSec: 10 } as ProjectPreferences['uiSettings'] });
    expect(out.uiSettings).toEqual({ volume: 1, zoomSec: 10 });
  });

  it('an explicit undefined clears the key', () => {
    const out = applyPreferencesPatch({ enteredFolderPath: '/a' }, { enteredFolderPath: undefined });
    expect(JSON.parse(JSON.stringify(out))).toEqual({});
  });

  it('does not mutate the stored preferences', () => {
    const latest: ProjectPreferences = { fileFilter: 'all' };
    applyPreferencesPatch(latest, { fileFilter: 'annotated' });
    expect(latest.fileFilter).toBe('all');
  });
});

describe('preferencesPatch', () => {
  it('returns only changed and removed keys', () => {
    const before: ProjectPreferences = { fileFilter: 'all', shuffleMode: true, findLabelUseRegex: true };
    const after: ProjectPreferences = { fileFilter: 'annotated', shuffleMode: true };
    expect(preferencesPatch(before, after)).toEqual({ fileFilter: 'annotated', findLabelUseRegex: undefined });
  });

  it('diffs uiSettings one level deep, so stale sibling fields are not sent', () => {
    const before = { uiSettings: { volume: 1, zoomSec: 30, videoMode: 'fast' } } as ProjectPreferences;
    const after = { uiSettings: { volume: 1, zoomSec: 30, videoMode: 'accurate' } } as ProjectPreferences;
    expect(preferencesPatch(before, after)).toEqual({ uiSettings: { videoMode: 'accurate' } });
  });

  it('is empty when nothing changed', () => {
    expect(preferencesPatch({ fileFilter: 'all' }, { fileFilter: 'all' })).toEqual({});
  });
});
