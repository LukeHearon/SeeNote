import { describe, it, expect } from 'vitest';
import { projectFormFromSettings, settingsFromProjectForm, missingProjectField } from '../utils/projectForm';
import type { ProjectSettings } from '../types';

const settings: ProjectSettings = {
  projectName: 'Bees',
  mediaDirectory: { kind: 'relative', path: './media' },
  annotationDirectory: { kind: 'relative', path: './annotations' },
  outputFormat: 'txt',
  outputRoundingDecimals: 4,
  nameGradientColors: ['#000000', '#ffffff'],
  gitSync: { remoteUrl: 'https://github.com/a/b.git' },
} as ProjectSettings;

describe('projectForm', () => {
  it('round-trips an existing project through the form', () => {
    const form = projectFormFromSettings(settings);
    const back = settingsFromProjectForm(form, '/p', 'https://github.com/a/b.git', settings);
    expect(back.projectName).toBe('Bees');
    expect(back.mediaDirectory).toEqual(settings.mediaDirectory);
    expect(back.annotationDirectory).toEqual(settings.annotationDirectory);
    expect(back.outputRoundingDecimals).toBe(4);
    expect(back.gitSync).toEqual({ remoteUrl: 'https://github.com/a/b.git' });
  });

  it('blank optional fields become unset, and no remote drops sync', () => {
    const form = { ...projectFormFromSettings(settings), filenameTimeFormat: '  ', buzzdetectDir: '' };
    const out = settingsFromProjectForm(form, '/p', '', settings);
    expect(out.filenameTimeFormat).toBeUndefined();
    expect(out.buzzdetectDirectory).toBeUndefined();
    expect(out.gitSync).toBeUndefined();
  });

  it('names the first missing required field', () => {
    const empty = projectFormFromSettings(undefined);
    expect(missingProjectField(empty)).toBe('name');
    expect(missingProjectField({ ...empty, name: 'x' })).toBe('media');
    expect(missingProjectField({ ...empty, name: 'x', mediaDir: 'm' })).toBe('annotations');
    expect(missingProjectField({ ...empty, name: 'x', mediaDir: 'm', annotationDir: 'a' })).toBeNull();
  });
});
