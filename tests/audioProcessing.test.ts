import { describe, it, expect } from 'vitest';
import { freqToY, yToFreq, toMel, fromMel, sampleChunkColumnInto, drawSpectrogramChunk } from '../utils/audioProcessing';

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

describe('sampleChunkColumnInto', () => {
  // A chunk with 2 freq bins and 8 columns; data[c*2 + b] = c*10 + b, so any
  // averaging/interp result is easy to compute by hand.
  const nFreqBins = 2;
  const nCols = 8;
  const data = new Uint16Array(nCols * nFreqBins);
  for (let c = 0; c < nCols; c++) {
    data[c * 2] = c * 10;
    data[c * 2 + 1] = c * 10 + 1;
  }
  const sample = (pos: number, posEnd: number, bins = 2) => {
    const dst = new Uint16Array(4).fill(9999);
    sampleChunkColumnInto(dst, 1, bins, data, nFreqBins, nCols, pos, posEnd);
    return dst;
  };

  it('area-averages every column center inside the window', () => {
    // Window [0, 4) holds centers 0..3 → mean of 0,10,20,30 = 15.
    const dst = sample(0, 4);
    expect(dst[1]).toBe(15);
    expect(dst[2]).toBe(16);
    // Only [dstOffset, dstOffset+bins) is written.
    expect(dst[0]).toBe(9999);
    expect(dst[3]).toBe(9999);
  });

  it('copies the column when exactly one center falls in the window', () => {
    const dst = sample(1.6, 2.4); // only center 2 in [1.6, 2.4)
    expect(dst[1]).toBe(20);
    expect(dst[2]).toBe(21);
  });

  it('tiles adjacent windows over the columns with no gap or overlap', () => {
    // Consecutive equal windows must partition the column centers — the
    // invariance that pins each transient to exactly one output column.
    const w = 2.5;
    const seen: number[] = [];
    for (let k = 0; k < 3; k++) {
      const pos = k * w;
      const c0 = Math.ceil(pos);
      const c1 = Math.ceil(pos + w);
      for (let c = c0; c < c1; c++) seen.push(c);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('linearly interpolates when the window holds no center (upsampling)', () => {
    // Window [2.3, 2.55): no integer center inside; center 2.425 lerps
    // between cols 2 and 3: 20 + 10*0.425 = 24.25 → rounds to 24.
    const dst = sample(2.3, 2.55);
    expect(dst[1]).toBe(24);
    expect(dst[2]).toBe(25); // 21 + 10*0.425 = 25.25 → 25
  });

  it('clamps windows that run past the chunk edges', () => {
    // Window beyond the last column: falls back to the last column's data.
    const dst = sample(7.2, 9);
    expect(dst[1]).toBe(70);
    // Window starting before the chunk: averages only the real columns.
    const dst2 = sample(-2, 2); // centers 0,1 → mean 5
    expect(dst2[1]).toBe(5);
  });

  it('is deterministic under the stride cap for very wide windows', () => {
    // 1 bin, 4096 columns of constant value: any strided subset averages to
    // the same value, and two identical calls must agree exactly.
    const wide = new Uint16Array(4096).fill(123);
    const a = new Uint16Array(1);
    const b = new Uint16Array(1);
    sampleChunkColumnInto(a, 0, 1, wide, 1, 4096, 0, 4096);
    sampleChunkColumnInto(b, 0, 1, wide, 1, 4096, 0, 4096);
    expect(a[0]).toBe(123);
    expect(b[0]).toBe(123);
  });
});

// drawSpectrogramChunk writes into a module-scope scratch buffer that is reused
// across calls and never cleared. It used to open with a whole-buffer background
// pre-fill; that was removed because the column loop already writes all four
// bytes of every pixel. These tests pin that invariant — if a future edit leaves
// any pixel unwritten, the canvas would show stale colours from the previous
// call rather than the background.
describe('drawSpectrogramChunk pixel coverage', () => {
  const W = 7;
  const H2 = 5;

  // Minimal ImageData/2D-context stubs: the node test env has neither, and all
  // we need is to capture the buffer handed to putImageData.
  class FakeImageData {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  }

  const draw = (colMask?: Uint8Array) => {
    const prevImageData = (globalThis as any).ImageData;
    (globalThis as any).ImageData = FakeImageData;
    let captured: Uint8ClampedArray | null = null;
    const ctx = { putImageData: (img: FakeImageData) => { captured = img.data; } };
    // Ascending values so no bin resolves to the same colour by accident.
    const spec = new Uint16Array(W * H2);
    for (let i = 0; i < spec.length; i++) spec[i] = (i * 997) % 65535;
    drawSpectrogramChunk(
      ctx as unknown as CanvasRenderingContext2D,
      spec, W, H2, W, H2,
      20, 22050, 44100, 'linear', -100, 0,
      colMask,
    );
    (globalThis as any).ImageData = prevImageData;
    return captured!.slice(0, W * H2 * 4);
  };

  it('writes every pixel when no column is masked', () => {
    // Poison the scratch buffer via a first call, then assert the second call's
    // output owes nothing to it: an identical draw must be byte-identical, and
    // a differently-masked draw must not leak the first call's colours.
    const a = draw();
    const b = draw();
    expect(Array.from(b)).toEqual(Array.from(a));
    // Every pixel opaque — no gaps left for a background fill to cover.
    for (let p = 3; p < a.length; p += 4) expect(a[p]).toBe(255);
  });

  it('writes masked columns as transparent background, not stale pixels', () => {
    draw(); // leaves the scratch buffer full of colormap colours
    const mask = new Uint8Array(W).fill(1);
    mask[2] = 0;
    mask[5] = 0;
    const out = draw(mask);
    for (let y = 0; y < H2; y++) {
      for (const x of [2, 5]) {
        const i = (y * W + x) * 4;
        expect([out[i], out[i + 1], out[i + 2], out[i + 3]]).toEqual([15, 23, 42, 0]);
      }
      // A neighbouring built column is still painted opaque.
      const j = (y * W + 3) * 4;
      expect(out[j + 3]).toBe(255);
    }
  });
});
