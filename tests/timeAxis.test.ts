import { describe, it, expect } from 'vitest';
import { formatRulerTime } from '../utils/timeAxis';

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
