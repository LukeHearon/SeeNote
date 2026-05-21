/**
 * videoZoom — shared zoom/pan model for the video panel.
 *
 * Single source of truth for both render paths (the frame-accurate
 * CanvasVideoPlayer and the <video>-element fallback). The model is a
 * `Viewport`: a uniform zoom factor plus the normalized centre of the
 * visible region in *source-frame* space. Because the visible region keeps
 * the frame's aspect ratio, it always maps undistorted into the letterboxed
 * display rect — the canvas path draws a sub-rect, the fallback path applies
 * an equivalent CSS transform, and both stay in lockstep.
 */

export interface Viewport {
  /** Uniform zoom factor, ≥ 1. 1 = whole frame visible. */
  zoom: number;
  /** Normalized centre of the visible region in frame space, [0,1]. */
  cx: number;
  cy: number;
}

/** Axis-aligned rect, units depend on caller (CSS px or normalized). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
/** Multiplicative step for the +/- buttons and wheel. */
export const ZOOM_STEP = 1.4;

export const DEFAULT_VIEWPORT: Viewport = { zoom: 1, cx: 0.5, cy: 0.5 };

export function isZoomed(vp: Viewport): boolean {
  return vp.zoom > MIN_ZOOM + 1e-4;
}

/** Clamp zoom to range and keep the visible region fully inside [0,1]. */
export function clampViewport(vp: Viewport): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom));
  const half = 0.5 / zoom;
  const cx = Math.min(1 - half, Math.max(half, vp.cx));
  const cy = Math.min(1 - half, Math.max(half, vp.cy));
  return { zoom, cx, cy };
}

/**
 * object-contain letterbox rect: where a frameW×frameH image sits inside a
 * boxW×boxH box, preserving aspect. Used by the overlay (coord mapping) and
 * the fallback player (absolute positioning of the <video>).
 */
export function computeContentRect(
  boxW: number,
  boxH: number,
  frameW: number,
  frameH: number,
): Rect {
  if (frameW <= 0 || frameH <= 0 || boxW <= 0 || boxH <= 0) {
    return { x: 0, y: 0, w: boxW, h: boxH };
  }
  const scale = Math.min(boxW / frameW, boxH / frameH);
  const w = frameW * scale;
  const h = frameH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/**
 * Draw `source` (a whole frame / video element) fitted into a boxW×boxH
 * context, object-contain letterboxed. Clears the box first. Shared by the
 * minimap's canvas path (VideoFrame cache) and its <video> fallback so the
 * two stay pixel-identical.
 */
export function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  boxW: number,
  boxH: number,
  srcW: number,
  srcH: number,
): void {
  const r = computeContentRect(boxW, boxH, srcW, srcH);
  ctx.clearRect(0, 0, boxW, boxH);
  try {
    ctx.drawImage(source, r.x, r.y, r.w, r.h);
  } catch {
    /* source not yet drawable */
  }
}

/**
 * The visible window as a normalized rect in frame space, [0,1], clamped so
 * it stays fully inside the frame. Single source of truth for "where the
 * viewport is looking" — `regionPx` scales it to pixels, the minimap renders
 * it as a percentage overlay.
 */
export function regionNorm(vp: Viewport): Rect {
  const size = 1 / vp.zoom;
  const x = Math.min(1 - size, Math.max(0, vp.cx - size / 2));
  const y = Math.min(1 - size, Math.max(0, vp.cy - size / 2));
  return { x, y, w: size, h: size };
}

/** Source sub-rect (in frame pixels) that the current viewport exposes. */
export function regionPx(vp: Viewport, frameW: number, frameH: number): Rect {
  const r = regionNorm(vp);
  return { x: r.x * frameW, y: r.y * frameH, w: r.w * frameW, h: r.h * frameH };
}

/**
 * Derive a new viewport from a marquee drawn over the displayed content.
 *
 * `content` is the rect (CSS px, relative to the same box) that the *current*
 * visible region occupies on screen — i.e. computeContentRect of the box.
 * `rect` is the user-drawn marquee in that same coordinate space. The result
 * is aspect-corrected (uses the larger fraction) so the whole marquee stays
 * visible without distortion. Tiny drags are treated as no-ops.
 */
export function viewportFromDragRect(
  vp: Viewport,
  content: Rect,
  rect: Rect,
): Viewport {
  if (rect.w < 6 || rect.h < 6 || content.w <= 0 || content.h <= 0) return vp;

  // Marquee as a fraction of the displayed content.
  const fx = (rect.x - content.x) / content.w;
  const fy = (rect.y - content.y) / content.h;
  const fw = rect.w / content.w;
  const fh = rect.h / content.h;

  // Current visible region in normalized frame space.
  const vSize = 1 / vp.zoom;
  const originX = vp.cx - vSize / 2;
  const originY = vp.cy - vSize / 2;

  const frac = Math.min(1, Math.max(fw, fh, 1e-3));
  const newZoom = vp.zoom / frac;
  const cx = originX + (fx + fw / 2) * vSize;
  const cy = originY + (fy + fh / 2) * vSize;
  return clampViewport({ zoom: newZoom, cx, cy });
}

/** Multiply zoom about the current centre (used by the +/- buttons). */
export function zoomBy(vp: Viewport, factor: number): Viewport {
  return clampViewport({ ...vp, zoom: vp.zoom * factor });
}

/** Re-centre on a normalized frame point (used by the minimap viewfinder). */
export function panToFraction(vp: Viewport, fx: number, fy: number): Viewport {
  return clampViewport({ ...vp, cx: fx, cy: fy });
}

/** Translate the viewport by (dx, dy) in normalized frame space (used by scroll-to-pan). */
export function panViewport(vp: Viewport, dx: number, dy: number): Viewport {
  return clampViewport({ ...vp, cx: vp.cx + dx, cy: vp.cy + dy });
}
