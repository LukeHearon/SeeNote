import { describe, it, expect } from 'vitest';
import {
  buildClick,
  envelope,
  rms,
  findOnset,
  median,
  detectRoundTrips,
} from '../utils/audioLoopback';

const SR = 48000;

/**
 * Synthesise a recording: noise floor everywhere, plus a copy of the click at
 * each of `delaysSec` after its emission time. This is the loopback the test
 * can't perform for real — the detection either recovers the delays it was
 * given or it doesn't.
 */
function synthRecording(
  lengthSec: number,
  clickCtxTimes: number[],
  delaysSec: number[],
  opts: { noise?: number; gain?: number; echoSec?: number } = {},
): Float32Array {
  const noise = opts.noise ?? 0.001;
  const gain = opts.gain ?? 0.3;
  const rec = new Float32Array(Math.round(lengthSec * SR));
  // Deterministic pseudo-noise so a failure is reproducible.
  let seed = 12345;
  for (let i = 0; i < rec.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rec[i] = ((seed / 0x7fffffff) * 2 - 1) * noise;
  }
  const click = buildClick(SR);
  const place = (atSec: number, amp: number) => {
    const start = Math.round(atSec * SR);
    for (let i = 0; i < click.length; i++) {
      if (start + i >= 0 && start + i < rec.length) rec[start + i] += click[i] * amp;
    }
  };
  for (let c = 0; c < clickCtxTimes.length; c++) {
    place(clickCtxTimes[c] + delaysSec[c], gain);
    // Optional reflection, louder than the direct sound — the case that breaks
    // peak-picking and is the reason findOnset walks back to the leading edge.
    if (opts.echoSec !== undefined) {
      place(clickCtxTimes[c] + delaysSec[c] + opts.echoSec, gain * 1.6);
    }
  }
  return rec;
}

/** Identity mapping: sample i was captured at i/SR seconds of context time. */
const identityCapture = (i: number) => i / SR;

describe('buildClick', () => {
  it('is windowed to zero at both ends', () => {
    const c = buildClick(SR);
    expect(c.length).toBeGreaterThan(10);
    expect(Math.abs(c[0])).toBeLessThan(1e-6);
    expect(Math.abs(c[c.length - 1])).toBeLessThan(1e-6);
  });

  it('peaks below full scale near the middle', () => {
    const c = buildClick(SR);
    let peakIdx = 0;
    for (let i = 0; i < c.length; i++) {
      if (Math.abs(c[i]) > Math.abs(c[peakIdx])) peakIdx = i;
    }
    expect(Math.abs(c[peakIdx])).toBeLessThanOrEqual(1);
    expect(peakIdx).toBeGreaterThan(c.length * 0.2);
    expect(peakIdx).toBeLessThan(c.length * 0.8);
  });
});

describe('envelope', () => {
  it('is non-negative and tracks a burst', () => {
    const x = new Float32Array(1000);
    for (let i = 400; i < 450; i++) x[i] = i % 2 === 0 ? 0.5 : -0.5;
    const env = envelope(x, SR);
    expect(env.every(v => v >= 0)).toBe(true);
    expect(env[425]).toBeGreaterThan(0.3);
    expect(env[100]).toBeLessThan(1e-6);
  });

  it('does not shift the burst later', () => {
    const x = new Float32Array(1000);
    for (let i = 400; i < 460; i++) x[i] = 0.5;
    const env = envelope(x, SR);
    let firstAbove = -1;
    for (let i = 0; i < env.length; i++) {
      if (env[i] > 0.1) { firstAbove = i; break; }
    }
    // Centred smoothing may lead slightly, but must never lag the true onset.
    expect(firstAbove).toBeGreaterThan(380);
    expect(firstAbove).toBeLessThanOrEqual(400);
  });
});

describe('rms', () => {
  it('measures a constant signal exactly', () => {
    const x = new Float32Array(100).fill(0.5);
    expect(rms(x)).toBeCloseTo(0.5, 6);
  });

  it('returns 0 for an empty or inverted range', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array(10).fill(1), 5, 5)).toBe(0);
  });
});

describe('findOnset', () => {
  it('returns null when nothing clears the noise floor', () => {
    const env = new Float32Array(1000).fill(0.01);
    expect(findOnset(env, 0, 1000, 0.01)).toBeNull();
  });

  it('finds the leading edge, not the peak', () => {
    const env = new Float32Array(1000);
    for (let i = 300; i < 320; i++) env[i] = 0.4;   // direct sound
    for (let i = 500; i < 520; i++) env[i] = 1.0;   // louder reflection
    const onset = findOnset(env, 0, 1000, 0.001);
    expect(onset).not.toBeNull();
    expect(onset!).toBeGreaterThanOrEqual(300);
    expect(onset!).toBeLessThan(330);
  });

  it('honours the search window', () => {
    const env = new Float32Array(1000);
    for (let i = 100; i < 120; i++) env[i] = 1;
    for (let i = 600; i < 620; i++) env[i] = 1;
    expect(findOnset(env, 500, 1000, 0.001)!).toBeGreaterThanOrEqual(600);
  });
});

describe('median', () => {
  it('handles odd and even lengths and is order-independent', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('rejects a single wild outlier', () => {
    expect(median([0.05, 0.051, 0.049, 0.05, 9.9])).toBeCloseTo(0.05, 3);
  });
});

describe('detectRoundTrips', () => {
  it('recovers a short, realistic round trip', () => {
    const clickTimes = [0.4, 1.0, 1.6];
    const delays = [0.042, 0.042, 0.042];
    const rec = synthRecording(3.0, clickTimes, delays);
    const { perClickSec } = detectRoundTrips(
      rec, SR, identityCapture, clickTimes, Math.round(0.2 * SR),
    );
    expect(perClickSec).toHaveLength(3);
    for (const d of perClickSec) expect(d).toBeCloseTo(0.042, 2);
  });

  it('recovers the half-second delay this test exists to catch', () => {
    const clickTimes = [0.4, 1.0, 1.6];
    const delays = [0.5, 0.5, 0.5];
    // Spacing is 0.6s, so a 0.5s delay still lands inside its own window.
    const rec = synthRecording(3.5, clickTimes, delays);
    const { perClickSec } = detectRoundTrips(
      rec, SR, identityCapture, clickTimes, Math.round(0.2 * SR),
    );
    expect(perClickSec).toHaveLength(3);
    expect(median(perClickSec)).toBeCloseTo(0.5, 2);
  });

  it('is not fooled by a reflection louder than the direct sound', () => {
    const clickTimes = [0.4, 1.0];
    const delays = [0.04, 0.04];
    const rec = synthRecording(2.5, clickTimes, delays, { echoSec: 0.03 });
    const { perClickSec } = detectRoundTrips(
      rec, SR, identityCapture, clickTimes, Math.round(0.2 * SR),
    );
    expect(median(perClickSec)).toBeCloseTo(0.04, 2);
  });

  it('reports no detections rather than guessing when the room is silent', () => {
    const clickTimes = [0.4, 1.0];
    const rec = synthRecording(2.0, clickTimes, [0.04, 0.04], { gain: 0 });
    const { perClickSec } = detectRoundTrips(
      rec, SR, identityCapture, clickTimes, Math.round(0.2 * SR),
    );
    expect(perClickSec).toHaveLength(0);
  });

  it('applies the capture-time mapping rather than assuming index/sr', () => {
    // A recording whose samples were captured 0.25s later than their index
    // suggests: every reported round trip must shrink by exactly that.
    const clickTimes = [0.4, 1.0];
    const delays = [0.3, 0.3];
    const rec = synthRecording(2.5, clickTimes, delays);
    const shifted = (i: number) => i / SR + 0.25;
    const { perClickSec } = detectRoundTrips(
      rec, SR, shifted, clickTimes, Math.round(0.2 * SR),
    );
    expect(median(perClickSec)).toBeCloseTo(0.55, 2);
  });
});
