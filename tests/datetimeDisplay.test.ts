import { describe, it, expect } from 'vitest';
import {
  formatDateTime,
  formatTimeOfDay,
  datetimeTicks,
  formatDatetimeRulerLabel,
  parseDatetimeInput,
} from '../utils/datetimeDisplay';

// 2026-01-01 22:47:30 local — deliberately off every round boundary so tick
// alignment has something to correct.
const START = new Date(2026, 0, 1, 22, 47, 30);

describe('formatDateTime / formatTimeOfDay', () => {
  it('adds the offset to the start time', () => {
    expect(formatDateTime(START, 0)).toBe('2026-01-01 22:47:30.00');
    expect(formatTimeOfDay(START, 90.25)).toBe('22:49:00.25');
  });

  it('rolls over into the next day', () => {
    expect(formatDateTime(START, 4350, 0)).toBe('2026-01-02 00:00:00');
  });

  it('honours the decimals argument', () => {
    expect(formatDateTime(START, 1.005, 0)).toBe('2026-01-01 22:47:31');
    expect(formatTimeOfDay(START, 0.999, 1)).toBe('22:47:31.0');
  });
});

describe('datetimeTicks', () => {
  it('lands on wall-clock boundaries, not multiples of step from t=0', () => {
    // Start is 22:47:30, so the first whole hour (23:00) is 750s in.
    expect(datetimeTicks(START, 0, 7300, 3600)).toEqual([750, 4350]);
  });

  it('places hour ticks on the hour', () => {
    const ticks = datetimeTicks(START, 0, 7300, 3600);
    for (const t of ticks) {
      const d = new Date(START.getTime() + t * 1000);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
    }
    expect(ticks.length).toBe(2); // 23:00 and 00:00 within the first ~2h
  });

  it('places minute ticks on the minute and respects the window', () => {
    const ticks = datetimeTicks(START, 100, 400, 60);
    expect(ticks[0]).toBe(150); // 22:50:00
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(400);
    expect(ticks.every(t => t >= 100)).toBe(true);
  });

  it('returns nothing for a degenerate window or step', () => {
    expect(datetimeTicks(START, 0, 100, 0)).toEqual([]);
    expect(datetimeTicks(START, 100, 50, 60)).toEqual([]);
  });
});

describe('formatDatetimeRulerLabel', () => {
  it('spells out the full date on the first label of a view', () => {
    expect(formatDatetimeRulerLabel(START, 750, null, 3600)).toBe('2026-01-01 23:00');
  });

  it('shows only the clock time while the day is unchanged', () => {
    expect(formatDatetimeRulerLabel(START, 750, 0, 3600)).toBe('23:00');
  });

  it('re-states month and day across midnight', () => {
    expect(formatDatetimeRulerLabel(START, 4350, 750, 3600)).toBe('01-02 00:00');
  });

  it('adds seconds (and sub-seconds) as the step gets finer', () => {
    expect(formatDatetimeRulerLabel(START, 30, 0, 10)).toBe('22:48:00');
    expect(formatDatetimeRulerLabel(START, 30.25, 0, 0.5)).toBe('22:48:00.25');
  });
});

describe('parseDatetimeInput', () => {
  it('parses a full datetime into an offset', () => {
    expect(parseDatetimeInput('2026-01-01 23:00:00', START, 180000)).toBe(750);
    expect(parseDatetimeInput('2026/01/02T00:00', START, 180000)).toBe(4350);
  });

  it('resolves a bare clock time to an occurrence inside the file', () => {
    expect(parseDatetimeInput('23:00', START, 180000)).toBe(750);
    // 01:00 is before the start on day one, so it means the next day's 01:00.
    expect(parseDatetimeInput('01:00', START, 180000)).toBe(750 + 2 * 3600);
  });

  it('carries fractional seconds', () => {
    expect(parseDatetimeInput('22:47:30.50', START, 180000)).toBeCloseTo(0.5, 6);
  });

  it('returns null for input that is not a datetime', () => {
    expect(parseDatetimeInput('83.45', START, 180000)).toBeNull();
    expect(parseDatetimeInput('1h10m', START, 180000)).toBeNull();
    expect(parseDatetimeInput('', START, 180000)).toBeNull();
  });
});
