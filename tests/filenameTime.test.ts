import { describe, it, expect } from 'vitest';
import { parseFilenameTime, formatFilenameTime, isUsableFilenameTimePattern } from '../utils/filenameTime';

const PATTERN = 'YYMMDD_HHMM';

describe('parseFilenameTime', () => {
  it('parses the FileSync-style pattern', () => {
    expect(parseFilenameTime('260731_0456.mp3', PATTERN)).toEqual(new Date(2026, 6, 31, 4, 56, 0));
  });

  it('reads MM as minutes once HH has appeared', () => {
    // 23:59 on 2026-01-01, not month 59.
    expect(parseFilenameTime('260101_2359.wav', PATTERN)).toEqual(new Date(2026, 0, 1, 23, 59, 0));
  });

  it('matches anywhere in the name, ignoring prefixes and suffixes', () => {
    expect(parseFilenameTime('hive3_260731_0456_part2.mp3', PATTERN))
      .toEqual(new Date(2026, 6, 31, 4, 56, 0));
  });

  it('supports 4-digit years and explicit minute/second tokens', () => {
    expect(parseFilenameTime('2026-07-31T04:56:07.flac', 'YYYY-MM-DDTHH:mm:ss'))
      .toEqual(new Date(2026, 6, 31, 4, 56, 7));
  });

  it('pivots 2-digit years at 70', () => {
    expect(parseFilenameTime('690101_0000.mp3', PATTERN)?.getFullYear()).toBe(2069);
    expect(parseFilenameTime('700101_0000.mp3', PATTERN)?.getFullYear()).toBe(1970);
  });

  it('defaults missing time-of-day fields to midnight', () => {
    expect(parseFilenameTime('20260731.mp3', 'YYYYMMDD')).toEqual(new Date(2026, 6, 31, 0, 0, 0));
  });

  it('returns null when the name does not match', () => {
    expect(parseFilenameTime('recording.mp3', PATTERN)).toBeNull();
    expect(parseFilenameTime('26073_0456.mp3', PATTERN)).toBeNull();
  });

  it('rejects field values that are not a real date or time', () => {
    expect(parseFilenameTime('260230_0456.mp3', PATTERN)).toBeNull(); // Feb 30
    expect(parseFilenameTime('261331_0456.mp3', PATTERN)).toBeNull(); // month 13
    expect(parseFilenameTime('260731_2560.mp3', PATTERN)).toBeNull(); // hour 25
  });

  it('returns null for a pattern that cannot pin down a date', () => {
    expect(parseFilenameTime('0456.mp3', 'HHmm')).toBeNull();
    expect(isUsableFilenameTimePattern('HHmm')).toBe(false);
    expect(isUsableFilenameTimePattern(PATTERN)).toBe(true);
  });
});

describe('formatFilenameTime', () => {
  it('is the inverse of parseFilenameTime', () => {
    const d = new Date(2026, 6, 31, 16, 56, 12);
    expect(formatFilenameTime(d, PATTERN)).toBe('260731_1656');
    expect(parseFilenameTime(formatFilenameTime(d, PATTERN), PATTERN))
      .toEqual(new Date(2026, 6, 31, 16, 56, 0));
  });

  it('keeps literals and pads every field', () => {
    expect(formatFilenameTime(new Date(2026, 0, 2, 3, 4, 5), 'YYYY-MM-DD_HH.mm.ss'))
      .toBe('2026-01-02_03.04.05');
  });
});
