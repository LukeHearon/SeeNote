import { describe, it, expect } from 'vitest';
import { formatRulerTime, parseHMS, rulerLabelAlign, rulerTicks } from '../utils/timeAxis';
import { buildSubsetTimeline, identityTimeline } from '../utils/subsetTimeline';

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

describe('rulerTicks', () => {
  // 100 px/s: the 85px minimum label spacing is 0.85s of display time.
  const PPS = 100;

  it('is nice ticks labelled with themselves when there is no subset', () => {
    expect(rulerTicks(identityTimeline(300), 0, 30, 10, PPS)).toEqual([
      { disp: 10, src: 10 },
      { disp: 20, src: 20 },
      { disp: 30, src: 30 },
    ]);
  });

  it('labels a subset with file times, not positions on the shortened axis', () => {
    // 300s file, detections at 1–2, 4–5, 6–7 → a 3s display axis. The second
    // segment sits at display 1s but is 4s into the file, and that is what its
    // label has to read.
    const tl = buildSubsetTimeline(
      [{ start: 1, end: 2 }, { start: 4, end: 5 }, { start: 6, end: 7 }],
      300,
    );
    expect(rulerTicks(tl, 0, 3, 1, PPS)).toEqual([
      { disp: 1, src: 4 },
      { disp: 2, src: 6 },
    ]);
  });

  it('ticks only at each segment start, even inside a long segment', () => {
    const tl = buildSubsetTimeline([{ start: 100, end: 160 }, { start: 200, end: 210 }], 300);
    const ticks = rulerTicks(tl, 0, 65, 10, PPS);
    expect(ticks).toEqual([{ disp: 60, src: 200 }]);
  });

  it('drops labels that would overprint across short segments', () => {
    // Twelve 0.1s segments, 10px apart at this zoom: only the ones far enough
    // from the last label drawn get one.
    const tl = buildSubsetTimeline(
      Array.from({ length: 12 }, (_, i) => ({ start: 10 * i, end: 10 * i + 0.1 })),
      300,
    );
    const ticks = rulerTicks(tl, 0, 1.2, 1, PPS);
    expect(ticks.map(t => t.src)).toEqual([10, 100]);
  });
});

describe('rulerLabelAlign', () => {
  it('centers labels on the identity timeline', () => {
    expect(rulerLabelAlign(identityTimeline(300))).toBe('center');
  });

  it('left-aligns labels under a subset, since each tick marks a segment start', () => {
    const tl = buildSubsetTimeline([{ start: 1, end: 2 }, { start: 4, end: 5 }], 300);
    expect(rulerLabelAlign(tl)).toBe('left');
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
