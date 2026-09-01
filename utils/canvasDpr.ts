/**
 * Device-pixel-ratio bookkeeping for the canvases.
 *
 * Every canvas in the app is drawn in CSS pixels: the bitmap is sized to
 * `cssSize * devicePixelRatio` and the context is scaled by the same dpr, so a
 * `10px` font is 10 CSS px on screen whatever the display. That only holds while
 * the two halves agree. They stop agreeing the moment `devicePixelRatio`
 * changes without the element's CSS box changing — a webview zoom step, a drag
 * onto a display with a different scale factor, a macOS resolution change. The
 * bitmap keeps the OLD dpr while the draw code scales by the NEW one, and the
 * browser stretches the result into the unchanged CSS box: geometry still fills
 * the canvas (it's all derived from the same bitmap), but every fixed-px font
 * shrinks or grows by the ratio between the two. That's the "y-axis labels went
 * tiny after zooming out" failure.
 *
 * The fix is to make sizing part of drawing rather than a separate resize pass:
 * `syncCanvasBitmap` is called at the top of each draw with the CSS box the
 * canvas is displayed at, and returns the dpr that same draw must scale by. The
 * pair can then never come from different moments in time.
 */

/** Current device pixel ratio, with a safe fallback for non-DOM environments. */
export const getDpr = (): number =>
  (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

/** Bitmap pixels needed to back `cssPx` CSS pixels at `dpr`. Never zero. */
export const bitmapSize = (cssPx: number, dpr: number): number =>
  Math.max(1, Math.round(cssPx * dpr));

export interface CanvasSize {
  /** Scale factor the caller must apply (`ctx.scale(dpr, dpr)`). */
  dpr: number;
  /** Canvas width in CSS pixels — the coordinate space to draw in. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** True if the bitmap was resized, which also cleared it. */
  resized: boolean;
}

/**
 * Size `canvas`'s bitmap to a `cssWidth * cssHeight` box at the current dpr and
 * report the dpr to draw with. Assigning to canvas.width/height clears the
 * canvas, so the assignment happens only when the value actually changes —
 * calling this every frame is free once the size has settled.
 *
 * Pass the CSS box explicitly (from a ResizeObserver's cached rect) rather than
 * letting this read `clientWidth`: the draws run inside a rAF loop, and a layout
 * read there costs a forced reflow every frame.
 */
export const syncCanvasBitmap = (
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasSize => {
  const dpr = getDpr();
  const w = bitmapSize(cssWidth, dpr);
  const h = bitmapSize(cssHeight, dpr);
  let resized = false;
  if (canvas.width !== w) { canvas.width = w; resized = true; }
  if (canvas.height !== h) { canvas.height = h; resized = true; }
  return { dpr, width: cssWidth, height: cssHeight, resized };
};

/**
 * Call `cb` whenever `devicePixelRatio` changes. There's no dpr event, so this
 * watches a media query pinned to the CURRENT ratio and re-arms itself against
 * the new ratio each time that query stops matching.
 */
export const onDprChange = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};

  let mql: MediaQueryList | null = null;
  let cancelled = false;

  const handler = () => {
    if (cancelled) return;
    arm();
    cb();
  };

  const arm = () => {
    mql?.removeEventListener('change', handler);
    mql = window.matchMedia(`(resolution: ${getDpr()}dppx)`);
    mql.addEventListener('change', handler);
  };

  arm();
  return () => {
    cancelled = true;
    mql?.removeEventListener('change', handler);
    mql = null;
  };
};
