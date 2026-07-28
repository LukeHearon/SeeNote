import { describe, it, expect } from 'vitest';
import { formatRulerTime, parseHMS } from '../utils/timeAxis';

describe('formatRulerTime', () => {
  it('shows hours when zoomed out past an hour', () => {
    expect(formatRulerTime(4500, 600, 7200)).toBe('1h15m00s');
  });

  it('shows hours when the timestamp itself is past an hour, even if zoomed in', () => {
    // 30s viewSpan (zoomed in) but the absolute position is 75 minutes in.
    expect(formatRulerTime(4500, 5, 30)).toBe('1h15m00s');
  });

  it('omits hours below an hour', () => {
    expect(formatRulerTime(125, 10, 300)).toBe('2m05s');
  });
});

describe('parseHMS', () => {
  it('parses hours and minutes', () => {
    expect(parseHMS('1h10m')).toBe(4200);
  });

  it('parses hours and seconds', () => {
    expect(parseHMS('1h10s')).toBe(3610);
  });

  it('parses hours, minutes, and seconds', () => {
    expect(parseHMS('0h3m01s')).toBe(181);
  });

  it('parses a single component', () => {
    expect(parseHMS('45s')).toBe(45);
    expect(parseHMS('5m')).toBe(300);
    expect(parseHMS('2h')).toBe(7200);
  });

  it('parses fractional seconds', () => {
    expect(parseHMS('1m30.5s')).toBe(90.5);
  });

  it('parses a leading minus sign', () => {
    expect(parseHMS('-1h10m')).toBe(-4200);
  });

  it('returns null for plain seconds and colon formats', () => {
    expect(parseHMS('83.45')).toBeNull();
    expect(parseHMS('1:23')).toBeNull();
  });

  it('returns null for empty or invalid input', () => {
    expect(parseHMS('')).toBeNull();
    expect(parseHMS('abc')).toBeNull();
  });
});
