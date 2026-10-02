import { describe, it, expect } from 'vitest';
import { TimeStretchEngine } from '../utils/TimeStretchEngine';
import {
  ANALYSIS_HOP,
  FFT_SIZE,
  phaseVocoderEffectiveSpeed,
  phaseVocoderHop,
} from '../utils/PhaseVocoder';
import { mediaTimeAt, ctxTimeAtMedia } from '../utils/audio/playbackClock';

const SR = 44100;

function sine(frames: number, freq = 440): Float32Array {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

/** Stream `total` frames through the engine in 1s chunks, flushing on the last. */
function run(speed: number, total: number, channels = 1): { out: number; engine: TimeStretchEngine } {
  const engine = new TimeStretchEngine();
  engine.setSpeed(speed);
  engine.reset(channels);
  const src = sine(total);
  let out = 0;
  for (let off = 0; off < total; off += SR) {
    const n = Math.min(SR, total - off);
    const chunk = src.subarray(off, off + n);
    const res = engine.stretch(Array.from({ length: channels }, () => chunk), n, off + n >= total);
    out += res.outputFrames;
  }
  return { out, engine };
}

describe('phase vocoder rate', () => {
  it('hop rounds to an integer, so the effective speed differs from the request', () => {
    expect(phaseVocoderHop(0.75)).toBe(171);
    expect(phaseVocoderEffectiveSpeed(0.75)).toBeCloseTo(128 / 171, 10);
    expect(phaseVocoderEffectiveSpeed(0.75)).not.toBeCloseTo(0.75, 4);
  });

  for (const speed of [0.75, 0.35, 0.9]) {
    it(`emits input/effectiveSpeed frames at ${speed}x (bounded, length-independent error)`, () => {
      const hop = phaseVocoderHop(speed);
      const eff = phaseVocoderEffectiveSpeed(speed);
      const errAt = (n: number) => {
        const { out, engine } = run(speed, n);
        expect(engine.effectiveSpeed).toBeCloseTo(eff, 12);
        return out - n / eff;
      };
      const short = errAt(60000);
      const long = errAt(160000);
      // Startup/flush edge effect only: fixed window latency, not a rate error.
      const bound = FFT_SIZE + (FFT_SIZE / ANALYSIS_HOP) * hop;
      expect(Math.abs(short)).toBeLessThan(bound);
      expect(Math.abs(long)).toBeLessThan(bound);
      // 100k extra frames of input must not change the error by more than a hop.
      expect(Math.abs(long - short)).toBeLessThanOrEqual(hop);
    });
  }

  it('playhead mapping through the effective rate tracks the input to within the edge latency', () => {
    const speed = 0.75;
    const a = run(speed, 40000);
    const b = run(speed, 340000);
    // Difference of two runs cancels the fixed edge latency, leaving the rate.
    const dCtx = (b.out - a.out) / SR;
    const truth = (340000 - 40000) / SR;
    const viaEffective = mediaTimeAt(0, dCtx, b.engine.effectiveSpeed, 1e9, null);
    const viaRequested = mediaTimeAt(0, dCtx, speed, 1e9, null);
    expect(Math.abs(viaEffective - truth)).toBeLessThan(0.004);
    // The requested speed is off by the 0.2% rate mismatch (~14ms over 6.8s of
    // media, and linearly more the longer the play).
    expect(Math.abs(viaRequested - truth)).toBeGreaterThan(0.008);
  });

  it('keeps mono mono and stereo stereo', () => {
    const mono = new TimeStretchEngine();
    mono.setSpeed(0.5);
    mono.reset(1);
    const m = mono.stretch([sine(SR)], SR, true);
    expect(m.channels.length).toBe(1);

    const stereo = new TimeStretchEngine();
    stereo.setSpeed(0.5);
    stereo.reset(2);
    const s = stereo.stretch([sine(SR), sine(SR)], SR, true);
    expect(s.channels.length).toBe(2);
    expect(s.channels[0].length).toBe(s.outputFrames);
  });

  it('preserves level (steady-state gain compensation)', () => {
    const e = new TimeStretchEngine();
    e.setSpeed(0.5);
    e.reset(1);
    const r = e.stretch([sine(40000)], 40000, true);
    const mid = r.channels[0].subarray(20000, 60000);
    let sum = 0;
    for (let i = 0; i < mid.length; i++) sum += mid[i] * mid[i];
    expect(Math.sqrt(sum / mid.length)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it('a second final flush adds nothing', () => {
    const e = new TimeStretchEngine();
    e.setSpeed(0.5);
    e.reset(1);
    e.stretch([sine(SR)], SR, true);
    expect(e.stretch([], 0, true).outputFrames).toBe(0);
  });
});

describe('SoundTouch rate and tail', () => {
  for (const speed of [1.5, 2, 3.5]) {
    it(`flushes to exactly input/${speed} frames`, () => {
      const total = SR * 5 + 123;
      const { out } = run(speed, total);
      expect(out).toBe(Math.round(total / speed));
    });
  }

  it('without the flush, the held-back tail would be missing', () => {
    const engine = new TimeStretchEngine();
    engine.setSpeed(2);
    engine.reset(1);
    const total = SR * 2;
    const noFlush = engine.stretch([sine(total)], total, false).outputFrames;
    expect(noFlush).toBeLessThan(total / 2);
  });
});

describe('mediaTimeAt / ctxTimeAtMedia', () => {
  it('is linear, clamps to duration and endSec, parks before the anchor', () => {
    expect(mediaTimeAt(10, 2, 0.5, 100, null)).toBeCloseTo(11);
    expect(mediaTimeAt(10, -1, 0.5, 100, null)).toBe(10);
    expect(mediaTimeAt(10, 1000, 1, 50, null)).toBe(50);
    expect(mediaTimeAt(10, 5, 1, 100, 12)).toBe(12);
  });
  it('inverts', () => {
    const ctx = ctxTimeAtMedia(3, 10, 12, 0.5);
    expect(mediaTimeAt(10, ctx - 3, 0.5, 100, null)).toBeCloseTo(12);
  });
});
