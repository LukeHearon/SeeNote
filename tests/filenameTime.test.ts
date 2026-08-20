import { describe, it, expect } from 'vitest';
import { parseFilenameTime, formatFilenameTime, isUsableFilenameTimePattern, parseFilenameOffsetSeconds, suggestExportFilename } from '../utils/filenameTime';

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

describe('parseFilenameOffsetSeconds', () => {
  it('reads the digits between the separator and the extension', () => {
    expect(parseFilenameOffsetSeconds('240903_1319_s52860.mp3', '_s')).toBe(52860);
  });

  it('returns null when the separator is empty', () => {
    expect(parseFilenameOffsetSeconds('240903_1319_s52860.mp3', '')).toBeNull();
  });

  it('returns null when the separator is not in the filename', () => {
    expect(parseFilenameOffsetSeconds('240903_1319.mp3', '_s')).toBeNull();
  });

  it('returns null when the text after the separator is not an integer', () => {
    expect(parseFilenameOffsetSeconds('240903_1319_snope.mp3', '_s')).toBeNull();
  });

  it('handles a filename with no extension', () => {
    expect(parseFilenameOffsetSeconds('240903_1319_s52860', '_s')).toBe(52860);
  });
});

describe('parseFilenameTime with an offset separator', () => {
  it('adds the parsed offset onto the parsed date, rolling over as needed', () => {
    // 2024-09-03 13:19 + 52860s = 2024-09-04 04:00:00
    expect(parseFilenameTime('240903_1319_s52860.mp3', 'YYMMDD_HHMM', '_s'))
      .toEqual(new Date(2024, 8, 4, 4, 0, 0));
  });

  it('falls back to the plain date when the separator is absent from the filename', () => {
    expect(parseFilenameTime('240903_1319.mp3', 'YYMMDD_HHMM', '_s'))
      .toEqual(new Date(2024, 8, 3, 13, 19, 0));
  });

  it('falls back to the plain date when the offset does not parse as an integer', () => {
    expect(parseFilenameTime('240903_1319_snope.mp3', 'YYMMDD_HHMM', '_s'))
      .toEqual(new Date(2024, 8, 3, 13, 19, 0));
  });

  it('ignores offsets entirely when no separator is given', () => {
    expect(parseFilenameTime('240903_1319_s52860.mp3', 'YYMMDD_HHMM'))
      .toEqual(new Date(2024, 8, 3, 13, 19, 0));
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

describe('suggestExportFilename', () => {
  it('appends an offset suffix when a separator is configured and the name has none yet', () => {
    expect(suggestExportFilename('200101_1200.mp3', 300, undefined, '_s')).toBe('200101_1200_s300.mp3');
  });

  it('stacks onto an existing offset suffix', () => {
    expect(suggestExportFilename('200101_1200_s400.mp3', 300, undefined, '_s')).toBe('200101_1200_s700.mp3');
  });

  it('re-renders the date pattern shifted forward when no separator is configured', () => {
    expect(suggestExportFilename('200101_1200.mp3', 3600, 'YYMMDD_HHMM')).toBe('200101_1300.mp3');
  });

  it('preserves a prefix/suffix around the matched date pattern', () => {
    expect(suggestExportFilename('hive3_200101_1200_part2.mp3', 3600, 'YYMMDD_HHMM'))
      .toBe('hive3_200101_1300_part2.mp3');
  });

  it('falls back to an implicit "_s" suffix with neither a separator nor a usable date format', () => {
    expect(suggestExportFilename('buzz.wav', 20)).toBe('buzz_s20.wav');
  });

  it('falls back to "_s" when a date format is configured but the name does not match it', () => {
    expect(suggestExportFilename('buzz.wav', 20, 'YYMMDD_HHMM')).toBe('buzz_s20.wav');
  });

  it('rounds a fractional start second', () => {
    expect(suggestExportFilename('buzz.wav', 20.6)).toBe('buzz_s21.wav');
  });
});
