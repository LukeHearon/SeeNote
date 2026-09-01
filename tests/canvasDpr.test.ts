import { describe, it, expect, afterEach } from 'vitest';
import { bitmapSize, getDpr, syncCanvasBitmap } from '../utils/canvasDpr';

// The real thing only ever reads/writes .width and .height. Track assignments so
// the "don't clear an already-correct canvas" guarantee can be asserted.
const fakeCanvas = () => {
  let w = 300;
  let h = 150;
  const c = {
    writes: 0,
    get width() { return w; },
    set width(v: number) { w = v; c.writes++; },
    get height() { return h; },
    set height(v: number) { h = v; c.writes++; },
  };
  return c as unknown as HTMLCanvasElement & { writes: number };
};

const withDpr = (dpr: number, fn: () => void) => {
  (globalThis as { window?: unknown }).window = { devicePixelRatio: dpr };
  try { fn(); } finally { delete (globalThis as { window?: unknown }).window; }
};

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('bitmapSize', () => {
  it('scales CSS pixels by the ratio', () => {
    expect(bitmapSize(50, 2)).toBe(100);
    expect(bitmapSize(100.4, 1)).toBe(100);
  });

  it('never returns a zero-width bitmap', () => {
    expect(bitmapSize(0, 2)).toBe(1);
    expect(bitmapSize(-5, 2)).toBe(1);
  });
});

describe('getDpr', () => {
  it('falls back to 1 outside a DOM', () => {
    expect(getDpr()).toBe(1);
  });

  it('reads devicePixelRatio when there is one', () => {
    withDpr(2.5, () => expect(getDpr()).toBe(2.5));
  });
});

describe('syncCanvasBitmap', () => {
  it('returns the CSS box to draw in and the ratio to scale by', () => {
    const canvas = fakeCanvas();
    withDpr(2, () => {
      const s = syncCanvasBitmap(canvas, 640, 480);
      expect(s).toMatchObject({ dpr: 2, width: 640, height: 480, resized: true });
      expect(canvas.width).toBe(1280);
      expect(canvas.height).toBe(960);
    });
  });

  it('leaves an already-correct bitmap untouched, so drawing does not clear it', () => {
    const canvas = fakeCanvas();
    withDpr(2, () => {
      syncCanvasBitmap(canvas, 640, 480);
      const writesAfterFirst = canvas.writes;
      const s = syncCanvasBitmap(canvas, 640, 480);
      expect(s.resized).toBe(false);
      expect(canvas.writes).toBe(writesAfterFirst);
    });
  });

  it('resizes when the ratio changes but the CSS box does not', () => {
    // The regression this module exists for: a webview zoom step changes dpr
    // alone, and a bitmap left at the old ratio makes every fixed-px label
    // render at the wrong size.
    const canvas = fakeCanvas();
    withDpr(2, () => syncCanvasBitmap(canvas, 50, 400));
    withDpr(0.8, () => {
      const s = syncCanvasBitmap(canvas, 50, 400);
      expect(s.resized).toBe(true);
      expect(s.dpr).toBe(0.8);
      expect(canvas.width).toBe(40);
      expect(canvas.height).toBe(320);
    });
  });
});
