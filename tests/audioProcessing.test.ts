import { describe, it, expect } from 'vitest';
import { freqToY, yToFreq, toMel, fromMel } from '../utils/audioProcessing';

const H = 500;            // canvas height
const MIN_F = 20;
const MAX_F = 22050;

// Sample y-values spread across the canvas (avoid exact endpoints for log/mel
// invertibility tests since normY=1 at y=0 maps to maxFreq exactly, which is fine,
// but we include them anyway to confirm boundary behavior).
const SAMPLE_YS = [0, 25, 73, 100, 173, 250, 333, 400, 450, 499, 500];

describe('toMel / fromMel', () => {
  it('round-trips frequencies through mel space', () => {
    for (const f of [20, 100, 440, 1000, 4000, 8000, 22050]) {
      expect(fromMel(toMel(f))).toBeCloseTo(f, 6);
    }
  });

  it('toMel(0) === 0', () => {
    expect(toMel(0)).toBe(0);
  });

  it('mel is monotonically increasing in frequency', () => {
    let prev = -Infinity;
    for (const f of [0, 10, 100, 500, 1000, 5000, 10000, 22050]) {
      const m = toMel(f);
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
  });
});

describe('freqToY / yToFreq boundary alignment (y=0 is TOP = maxFreq)', () => {
  for (const scale of ['linear', 'log', 'mel'] as const) {
    it(`${scale}: y=0 maps to maxFreq`, () => {
      const f = yToFreq(0, H, MIN_F, MAX_F, scale);
      // For 'log' with minFreq=20, maxFreq is hit exactly.
      expect(f).toBeCloseTo(MAX_F, 6);
    });

    it(`${scale}: y=canvasHeight maps to minFreq`, () => {
      const f = yToFreq(H, H, MIN_F, MAX_F, scale);
      expect(f).toBeCloseTo(MIN_F, 6);
    });

    it(`${scale}: freqToY(maxFreq) === 0`, () => {
      expect(freqToY(MAX_F, H, MIN_F, MAX_F, scale)).toBeCloseTo(0, 6);
    });

    it(`${scale}: freqToY(minFreq) === canvasHeight`, () => {
      expect(freqToY(MIN_F, H, MIN_F, MAX_F, scale)).toBeCloseTo(H, 6);
    });
  }
});

describe('freqToY ∘ yToFreq invertibility', () => {
  for (const scale of ['linear', 'log', 'mel'] as const) {
    it(`${scale}: round-trips y → freq → y`, () => {
      const tol = scale === 'mel' ? 1e-3 : 1e-6;
      for (const y of SAMPLE_YS) {
        const f = yToFreq(y, H, MIN_F, MAX_F, scale);
        const yBack = freqToY(f, H, MIN_F, MAX_F, scale);
        expect(yBack).toBeCloseTo(y, scale === 'mel' ? 3 : 6);
        // Also sanity-check the absolute difference against the tolerance.
        expect(Math.abs(yBack - y)).toBeLessThan(tol + 1e-9);
      }
    });
  }

  it('linear: round-trips freq → y → freq across a sweep', () => {
    for (const f of [20, 100, 440, 1000, 4000, 10000, 22050]) {
      const y = freqToY(f, H, MIN_F, MAX_F, 'linear');
      expect(yToFreq(y, H, MIN_F, MAX_F, 'linear')).toBeCloseTo(f, 6);
    }
  });

  it('log: round-trips freq → y → freq across a sweep', () => {
    for (const f of [20, 100, 440, 1000, 4000, 10000, 22050]) {
      const y = freqToY(f, H, MIN_F, MAX_F, 'log');
      expect(yToFreq(y, H, MIN_F, MAX_F, 'log')).toBeCloseTo(f, 4);
    }
  });

  it('mel: round-trips freq → y → freq across a sweep', () => {
    for (const f of [20, 100, 440, 1000, 4000, 10000, 22050]) {
      const y = freqToY(f, H, MIN_F, MAX_F, 'mel');
      expect(yToFreq(y, H, MIN_F, MAX_F, 'mel')).toBeCloseTo(f, 3);
    }
  });
});

describe('linear scale exact arithmetic', () => {
  it('midpoint y = H/2 maps to (min+max)/2', () => {
    const mid = yToFreq(H / 2, H, MIN_F, MAX_F, 'linear');
    expect(mid).toBeCloseTo((MIN_F + MAX_F) / 2, 6);
  });

  it('quarter y = H/4 maps to minFreq + 0.75*(max-min) (top-quarter)', () => {
    // y=0 is top (max), so y=H/4 is 3/4 of the way up → normY = 0.75
    const f = yToFreq(H / 4, H, MIN_F, MAX_F, 'linear');
    expect(f).toBeCloseTo(MIN_F + 0.75 * (MAX_F - MIN_F), 6);
  });

  it('freqToY of midpoint freq equals H/2', () => {
    const y = freqToY((MIN_F + MAX_F) / 2, H, MIN_F, MAX_F, 'linear');
    expect(y).toBeCloseTo(H / 2, 6);
  });
});

describe('log scale: minFreq=0 clamping (avoids log(0))', () => {
  // Code clamps safeMinFreq = max(minFreq, 1). So passing minFreq=0 should
  // behave identically to minFreq=1 for log scale.
  it('yToFreq with minFreq=0 produces finite values everywhere', () => {
    for (const y of SAMPLE_YS) {
      const f = yToFreq(y, H, 0, MAX_F, 'log');
      expect(Number.isFinite(f)).toBe(true);
    }
  });

  it('yToFreq(minFreq=0, log) === yToFreq(minFreq=1, log)', () => {
    for (const y of SAMPLE_YS) {
      const f0 = yToFreq(y, H, 0, MAX_F, 'log');
      const f1 = yToFreq(y, H, 1, MAX_F, 'log');
      expect(f0).toBeCloseTo(f1, 6);
    }
  });

  it('freqToY with minFreq=0 produces finite values for freq>=1', () => {
    for (const f of [1, 10, 100, 1000, 10000, 22050]) {
      const y = freqToY(f, H, 0, MAX_F, 'log');
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('log invertibility holds with minFreq=0 (clamped to 1)', () => {
    for (const y of SAMPLE_YS) {
      const f = yToFreq(y, H, 0, MAX_F, 'log');
      const yBack = freqToY(f, H, 0, MAX_F, 'log');
      expect(yBack).toBeCloseTo(y, 6);
    }
  });
});

describe('log scale: geometric midpoint', () => {
  it('midpoint y = H/2 maps to geometric mean of (clamped) min and max', () => {
    const min = 20, max = 20000;
    const f = yToFreq(H / 2, H, min, max, 'log');
    expect(f).toBeCloseTo(Math.sqrt(min * max), 4);
  });
});

describe('monotonicity: higher y means lower freq (y=0 is top/highest)', () => {
  for (const scale of ['linear', 'log', 'mel'] as const) {
    it(`${scale}: yToFreq is strictly decreasing in y`, () => {
      let prev = Infinity;
      for (let y = 0; y <= H; y += 25) {
        const f = yToFreq(y, H, MIN_F, MAX_F, scale);
        expect(f).toBeLessThan(prev);
        prev = f;
      }
    });

    it(`${scale}: freqToY is strictly decreasing in freq`, () => {
      let prev = Infinity;
      const min = scale === 'log' ? 1 : MIN_F;
      for (const f of [min, 50, 200, 1000, 5000, 15000, MAX_F]) {
        const y = freqToY(f, H, min, MAX_F, scale);
        expect(y).toBeLessThan(prev);
        prev = y;
      }
    });
  }
});

describe('mel scale: midpoint y maps to mid-mel frequency', () => {
  it('y=H/2 corresponds to fromMel((toMel(min)+toMel(max))/2)', () => {
    const expected = fromMel((toMel(MIN_F) + toMel(MAX_F)) / 2);
    const got = yToFreq(H / 2, H, MIN_F, MAX_F, 'mel');
    expect(got).toBeCloseTo(expected, 6);
  });
});

describe('different canvas heights', () => {
  for (const ch of [100, 256, 720, 1080]) {
    it(`linear invertibility at canvasHeight=${ch}`, () => {
      for (const y of [0, ch / 4, ch / 2, (3 * ch) / 4, ch]) {
        const f = yToFreq(y, ch, MIN_F, MAX_F, 'linear');
        expect(freqToY(f, ch, MIN_F, MAX_F, 'linear')).toBeCloseTo(y, 6);
      }
    });
  }
});
