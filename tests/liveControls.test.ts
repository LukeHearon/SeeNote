import { describe, it, expect } from 'vitest';
import { parseTimestamp } from '../utils/timeAxis';
import { speedToSlider, sliderToSpeed, SPEED_MIN, SPEED_MAX } from '../utils/helpers';
import { speedRangeFor } from '../components/Toolbar';

// These three are the pure core of the toolbar controls that the help guide now
// renders live copies of (components/controls/*). Both places drive the same
// functions, so pinning them here pins the behaviour in both.

describe('parseTimestamp', () => {
  it('parses plain seconds', () => {
    expect(parseTimestamp('83.45')).toBeCloseTo(83.45);
    expect(parseTimestamp('0')).toBe(0);
    expect(parseTimestamp('  12  ')).toBe(12);
  });

  it('parses mm:ss and hh:mm:ss', () => {
    expect(parseTimestamp('1:23')).toBe(83);
    expect(parseTimestamp('1:23.45')).toBeCloseTo(83.45);
    expect(parseTimestamp('1:23:45')).toBe(5025);
    expect(parseTimestamp('0:00')).toBe(0);
  });

  it('parses h/m/s shorthand', () => {
    expect(parseTimestamp('1h10m')).toBe(4200);
    expect(parseTimestamp('1h10s')).toBe(3610);
    expect(parseTimestamp('0h3m01s')).toBe(181);
    expect(parseTimestamp('45s')).toBe(45);
  });

  it('rejects negatives and nonsense', () => {
    // selDur is the one field that allows a negative, and it parses with
    // parseHMS directly rather than through here.
    expect(parseTimestamp('-5')).toBeNull();
    expect(parseTimestamp('-1h')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    // Would be 1 under a bare parseFloat, which silently truncated to the
    // leading number and seeked to one second.
    expect(parseTimestamp('1:2:3:4')).toBeNull();
    expect(parseTimestamp('12abc')).toBeNull();
  });

  it('prefers the colon forms over plain float parsing', () => {
    // parseFloat('1:23') would silently yield 1 — the colon branch must win.
    expect(parseTimestamp('1:23')).toBe(83);
  });
});

describe('speed slider mapping', () => {
  it('puts 1.0x exactly at the slider centre', () => {
    expect(speedToSlider(1)).toBeCloseTo(0.5, 10);
    expect(sliderToSpeed(0.5)).toBeCloseTo(1, 10);
  });

  it('maps the endpoints to 0 and 1', () => {
    expect(speedToSlider(SPEED_MIN)).toBeCloseTo(0, 10);
    expect(speedToSlider(SPEED_MAX)).toBeCloseTo(1, 10);
    expect(sliderToSpeed(0)).toBeCloseTo(SPEED_MIN, 10);
    expect(sliderToSpeed(1)).toBeCloseTo(SPEED_MAX, 10);
  });

  it('round-trips', () => {
    for (const speed of [0.25, 0.4, 0.5, 1, 1.5, 2, 3.3, 4]) {
      expect(sliderToSpeed(speedToSlider(speed))).toBeCloseTo(speed, 10);
    }
  });

  it('is logarithmic — equal travel halves and doubles', () => {
    const half = speedToSlider(0.5), one = speedToSlider(1), two = speedToSlider(2);
    expect(one - half).toBeCloseTo(two - one, 10);
  });
});

describe('speedRangeFor', () => {
  it('gives audio tracks the full range in every video mode', () => {
    for (const mode of ['off', 'fast', 'mixed', 'accurate'] as const) {
      expect(speedRangeFor(true, mode)).toEqual({ min: SPEED_MIN, max: SPEED_MAX });
    }
  });

  it('narrows free-running video modes', () => {
    // Fast and Mixed drive a <video> element playing its own audio, which can't
    // be stretched as far as the audio engine.
    expect(speedRangeFor(false, 'fast')).toEqual({ min: 0.5, max: 2.0 });
    expect(speedRangeFor(false, 'mixed')).toEqual({ min: 0.5, max: 2.0 });
  });

  it('leaves decoded video modes at the full range', () => {
    expect(speedRangeFor(false, 'accurate')).toEqual({ min: SPEED_MIN, max: SPEED_MAX });
    expect(speedRangeFor(false, 'off')).toEqual({ min: SPEED_MIN, max: SPEED_MAX });
  });
});
