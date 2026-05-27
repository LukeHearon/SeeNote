import { describe, it, expect } from 'vitest';
import {
  isZoomed,
  clampViewport,
  computeContentRect,
  regionNorm,
  regionPx,
  viewportFromDragRect,
  zoomBy,
  panToFraction,
  panViewport,
  DEFAULT_VIEWPORT,
  MIN_ZOOM,
  MAX_ZOOM,
  type Viewport,
  type Rect,
} from '../utils/videoZoom';

describe('isZoomed', () => {
  it('returns false for the identity viewport', () => {
    expect(isZoomed(DEFAULT_VIEWPORT)).toBe(false);
  });

  it('returns false for zoom exactly at MIN_ZOOM', () => {
    expect(isZoomed({ zoom: MIN_ZOOM, cx: 0.5, cy: 0.5 })).toBe(false);
  });

  it('returns false for zoom within the epsilon of identity', () => {
    expect(isZoomed({ zoom: 1 + 1e-5, cx: 0.5, cy: 0.5 })).toBe(false);
  });

  it('returns true for an obviously zoomed viewport', () => {
    expect(isZoomed({ zoom: 2, cx: 0.5, cy: 0.5 })).toBe(true);
  });

  it('returns true just past the epsilon threshold', () => {
    expect(isZoomed({ zoom: 1 + 1e-3, cx: 0.5, cy: 0.5 })).toBe(true);
  });
});

describe('clampViewport', () => {
  it('leaves an in-bounds viewport unchanged', () => {
    const vp: Viewport = { zoom: 2, cx: 0.5, cy: 0.5 };
    const out = clampViewport(vp);
    expect(out.zoom).toBeCloseTo(2, 10);
    expect(out.cx).toBeCloseTo(0.5, 10);
    expect(out.cy).toBeCloseTo(0.5, 10);
  });

  it('clamps zoom below MIN_ZOOM up to MIN_ZOOM', () => {
    expect(clampViewport({ zoom: 0.1, cx: 0.5, cy: 0.5 }).zoom).toBe(MIN_ZOOM);
  });

  it('clamps zoom above MAX_ZOOM down to MAX_ZOOM', () => {
    expect(clampViewport({ zoom: 999, cx: 0.5, cy: 0.5 }).zoom).toBe(MAX_ZOOM);
  });

  it('clamps a centre that pulls the window past the left/top edge', () => {
    // zoom=2 → half=0.25, so cx,cy must be in [0.25, 0.75]
    const out = clampViewport({ zoom: 2, cx: 0, cy: 0 });
    expect(out.cx).toBeCloseTo(0.25, 10);
    expect(out.cy).toBeCloseTo(0.25, 10);
  });

  it('clamps a centre that pulls the window past the right/bottom edge', () => {
    const out = clampViewport({ zoom: 4, cx: 1, cy: 1 });
    // half = 0.125
    expect(out.cx).toBeCloseTo(0.875, 10);
    expect(out.cy).toBeCloseTo(0.875, 10);
  });

  it('at zoom=1, centre is pinned to 0.5 regardless of input', () => {
    const out = clampViewport({ zoom: 1, cx: 0.1, cy: 0.9 });
    expect(out.cx).toBeCloseTo(0.5, 10);
    expect(out.cy).toBeCloseTo(0.5, 10);
  });
});

describe('computeContentRect', () => {
  it('fills the box when aspect ratios match exactly', () => {
    const r = computeContentRect(200, 100, 400, 200);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(0, 10);
    expect(r.w).toBeCloseTo(200, 10);
    expect(r.h).toBeCloseTo(100, 10);
  });

  it('letterboxes a wider-than-box landscape frame (bars top/bottom)', () => {
    // 400x100 (4:1) inside a 200x100 (2:1) box → scale 0.5, h=50, vertical bars
    const r = computeContentRect(200, 100, 400, 100);
    expect(r.w).toBeCloseTo(200, 10);
    expect(r.h).toBeCloseTo(50, 10);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(25, 10);
    // full width
    expect(r.x + r.w).toBeCloseTo(200, 10);
  });

  it('pillarboxes a portrait frame in a landscape box (bars left/right)', () => {
    // 100x200 frame in 400x200 box → scale 1, content 100x200 centered
    const r = computeContentRect(400, 200, 100, 200);
    expect(r.w).toBeCloseTo(100, 10);
    expect(r.h).toBeCloseTo(200, 10);
    expect(r.x).toBeCloseTo(150, 10);
    expect(r.y).toBeCloseTo(0, 10);
    expect(r.y + r.h).toBeCloseTo(200, 10);
  });

  it('returns full-box rect when frame dims are zero', () => {
    const r = computeContentRect(300, 200, 0, 100);
    expect(r).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it('returns full-box rect when box dims are zero', () => {
    const r = computeContentRect(0, 200, 400, 100);
    expect(r).toEqual({ x: 0, y: 0, w: 0, h: 200 });
  });

  it('shrinks a large frame uniformly into a small box', () => {
    const r = computeContentRect(100, 100, 1000, 500);
    // scale = min(100/1000, 100/500) = 0.1
    expect(r.w).toBeCloseTo(100, 10);
    expect(r.h).toBeCloseTo(50, 10);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(25, 10);
  });
});

describe('regionNorm / regionPx', () => {
  it('identity viewport spans the whole frame normalized', () => {
    const r = regionNorm(DEFAULT_VIEWPORT);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(0, 10);
    expect(r.w).toBeCloseTo(1, 10);
    expect(r.h).toBeCloseTo(1, 10);
  });

  it('zoomed centred viewport produces a centred sub-rect', () => {
    const r = regionNorm({ zoom: 2, cx: 0.5, cy: 0.5 });
    expect(r.x).toBeCloseTo(0.25, 10);
    expect(r.y).toBeCloseTo(0.25, 10);
    expect(r.w).toBeCloseTo(0.5, 10);
    expect(r.h).toBeCloseTo(0.5, 10);
  });

  it('regionNorm clamps a viewport pushed against an edge', () => {
    // cx well past the right edge → clamped so x = 1 - size
    const r = regionNorm({ zoom: 4, cx: 2, cy: 2 });
    expect(r.w).toBeCloseTo(0.25, 10);
    expect(r.x).toBeCloseTo(0.75, 10);
    expect(r.y).toBeCloseTo(0.75, 10);
  });

  it('regionPx scales normalized region by frame dimensions', () => {
    const r = regionPx({ zoom: 2, cx: 0.5, cy: 0.5 }, 1920, 1080);
    expect(r.x).toBeCloseTo(480, 6);
    expect(r.y).toBeCloseTo(270, 6);
    expect(r.w).toBeCloseTo(960, 6);
    expect(r.h).toBeCloseTo(540, 6);
  });

  it('regionPx round-trips with regionNorm via frame dims', () => {
    const vp: Viewport = { zoom: 3, cx: 0.4, cy: 0.6 };
    const norm = regionNorm(vp);
    const px = regionPx(vp, 800, 600);
    expect(px.x / 800).toBeCloseTo(norm.x, 10);
    expect(px.y / 600).toBeCloseTo(norm.y, 10);
    expect(px.w / 800).toBeCloseTo(norm.w, 10);
    expect(px.h / 600).toBeCloseTo(norm.h, 10);
  });
});

describe('viewportFromDragRect', () => {
  const content: Rect = { x: 0, y: 0, w: 400, h: 200 };

  it('returns the input viewport when the drag is too small (< 6px)', () => {
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 10, y: 10, w: 5, h: 100 });
    expect(out).toBe(vp);
    const out2 = viewportFromDragRect(vp, content, { x: 10, y: 10, w: 100, h: 5 });
    expect(out2).toBe(vp);
  });

  it('returns the input viewport when content has zero dimensions', () => {
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const zero: Rect = { x: 0, y: 0, w: 0, h: 200 };
    expect(viewportFromDragRect(vp, zero, { x: 0, y: 0, w: 50, h: 50 })).toBe(vp);
  });

  it('a drag matching the entire content rect produces zoom ~= 1 centred', () => {
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 0, y: 0, w: 400, h: 200 });
    expect(out.zoom).toBeCloseTo(1, 10);
    expect(out.cx).toBeCloseTo(0.5, 10);
    expect(out.cy).toBeCloseTo(0.5, 10);
  });

  it('a half-width, half-height marquee at the centre zooms to 2x at the centre', () => {
    // fw = fh = 0.5 → frac = 0.5 → newZoom = 2
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 100, y: 50, w: 200, h: 100 });
    expect(out.zoom).toBeCloseTo(2, 10);
    expect(out.cx).toBeCloseTo(0.5, 10);
    expect(out.cy).toBeCloseTo(0.5, 10);
  });

  it('uses the larger of fw/fh so the marquee stays fully visible (no distortion)', () => {
    // fw = 0.5, fh = 0.25 → frac = 0.5 → newZoom = 2 (not 4)
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 100, y: 75, w: 200, h: 50 });
    expect(out.zoom).toBeCloseTo(2, 10);
  });

  it('upper-left quadrant marquee centres on that quadrant', () => {
    // marquee 0..200 x 0..100 → fx=0,fy=0,fw=0.5,fh=0.5 → centre at (0.25,0.25), zoom 2
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 0, y: 0, w: 200, h: 100 });
    expect(out.zoom).toBeCloseTo(2, 10);
    expect(out.cx).toBeCloseTo(0.25, 10);
    expect(out.cy).toBeCloseTo(0.25, 10);
  });

  it('clamps the resulting viewport into bounds', () => {
    // tiny marquee in upper-left → high zoom; ensure cx,cy clamped
    const vp: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 0, y: 0, w: 10, h: 10 });
    const half = 0.5 / out.zoom;
    expect(out.cx).toBeGreaterThanOrEqual(half - 1e-10);
    expect(out.cx).toBeLessThanOrEqual(1 - half + 1e-10);
    expect(out.cy).toBeGreaterThanOrEqual(half - 1e-10);
    expect(out.cy).toBeLessThanOrEqual(1 - half + 1e-10);
    expect(out.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('composes with an already-zoomed viewport: drag is relative to visible region', () => {
    // vp zoom=2 centred → visible region is normalized [0.25..0.75]
    // Drag matching whole content → newZoom = 2 (unchanged), centre stays at 0.5
    const vp: Viewport = { zoom: 2, cx: 0.5, cy: 0.5 };
    const out = viewportFromDragRect(vp, content, { x: 0, y: 0, w: 400, h: 200 });
    expect(out.zoom).toBeCloseTo(2, 10);
    expect(out.cx).toBeCloseTo(0.5, 10);
    expect(out.cy).toBeCloseTo(0.5, 10);
  });
});

describe('zoomBy / panToFraction / panViewport (clamped helpers)', () => {
  it('zoomBy multiplies and clamps', () => {
    const out = zoomBy({ zoom: 2, cx: 0.5, cy: 0.5 }, 100);
    expect(out.zoom).toBe(MAX_ZOOM);
  });

  it('panToFraction re-centres and then clamps', () => {
    const out = panToFraction({ zoom: 2, cx: 0.5, cy: 0.5 }, 0, 0);
    expect(out.cx).toBeCloseTo(0.25, 10);
    expect(out.cy).toBeCloseTo(0.25, 10);
  });

  it('panViewport translates by delta and clamps', () => {
    const out = panViewport({ zoom: 2, cx: 0.5, cy: 0.5 }, 1, 1);
    expect(out.cx).toBeCloseTo(0.75, 10);
    expect(out.cy).toBeCloseTo(0.75, 10);
  });
});
