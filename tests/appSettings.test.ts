import { describe, it, expect } from 'vitest';
import { resolveDateTimeFormat, resolveAnnotatorName, withSingleFileSettings } from '../utils/appSettings';
import { DEFAULT_DATE_TIME_FORMAT } from '../constants';

describe('resolveDateTimeFormat', () => {
  it('prefers the app-wide setting over a legacy project value', () => {
    expect(resolveDateTimeFormat({ dateTimeFormat: 'iso' }, 'friendly')).toBe('iso');
  });
  it('falls back to the legacy project value, then the default', () => {
    expect(resolveDateTimeFormat({}, 'iso')).toBe('iso');
    expect(resolveDateTimeFormat(null)).toBe(DEFAULT_DATE_TIME_FORMAT);
  });
});

describe('resolveAnnotatorName', () => {
  it('prefers the app-wide name, trimmed', () => {
    expect(resolveAnnotatorName({ annotatorName: ' Ana ' }, 'Old')).toBe('Ana');
  });
  it('treats a blank app-wide name as unset', () => {
    expect(resolveAnnotatorName({ annotatorName: '  ' }, 'Old')).toBe('Old');
    expect(resolveAnnotatorName(null)).toBe('');
  });
});

describe('withSingleFileSettings', () => {
  it('merges into the single-file block without touching other settings', () => {
    const base = { ffmpegPath: '/x', singleFile: { filenameTimeFormat: 'YYMMDD', buzzdetectFrameLength: 0.96 } };
    const next = withSingleFileSettings(base, { buzzdetectFrameLength: undefined, buzzdetectTrimActivationPrefix: false });
    expect(next).toEqual({
      ffmpegPath: '/x',
      singleFile: { filenameTimeFormat: 'YYMMDD', buzzdetectFrameLength: undefined, buzzdetectTrimActivationPrefix: false },
    });
    expect(base.singleFile.buzzdetectFrameLength).toBe(0.96);
  });
  it('creates the block when absent', () => {
    expect(withSingleFileSettings({}, { filenameTimeFormat: 'YYYY' })).toEqual({ singleFile: { filenameTimeFormat: 'YYYY' } });
  });
});
