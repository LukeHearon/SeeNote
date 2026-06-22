import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScanSearch, ZoomIn, ZoomOut, Maximize2, Search } from 'lucide-react';
import { useHotkeys } from '../hooks/useHotkeys';
import { tooltips } from '../copy/tooltips';
import {
  DEFAULT_VIEWPORT,
  ZOOM_STEP,
  clampViewport,
  computeContentRect,
  isZoomed,
  panToFraction,
  regionNorm,
  viewportFromDragRect,
  zoomBy,
  type Rect,
  type Viewport,
} from '../utils/videoZoom';

interface VideoZoomLayerProps {
  viewport: Viewport;
  onViewportChange: (vp: Viewport) => void;
  /** Intrinsic media dimensions; 0 until known (marquee/minimap disabled). */
  frameW: number;
  frameH: number;
  toolActive: boolean;
  onToolActiveChange: (active: boolean) => void;
  /** Draws the whole current frame fitted into a w×h context for the
   *  minimap. Absent → minimap shows a plain placeholder. */
  drawThumbnail?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  onToggleZoomState?: () => void;
}

const MINIMAP_MAX_W = 168;
const MINIMAP_MAX_H = 120;

/**
 * Overlay for the video panel: a right-edge control strip (marquee-zoom
 * tool, +/-, reset), a drag-to-zoom marquee, and a bottom-right minimap
 * viewfinder. All zoom math lives in utils/videoZoom — this component only
 * captures intent and renders feedback, so the canvas and <video> paths
 * stay in lockstep.
 */
export default function VideoZoomLayer({
  viewport,
  onViewportChange,
  frameW,
  frameH,
  toolActive,
  onToolActiveChange,
  onToggleZoomState,
  drawThumbnail,
}: VideoZoomLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const haveDims = frameW > 0 && frameH > 0;
  const zoomed = isZoomed(viewport);

  // Change 4: track container height to detect minimap/button overlap.
  const [containerH, setContainerH] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Shift+Z toggles the marquee-zoom drawing tool (plain Z toggles zoom state
  // in VideoPane; mod+z / mod+shift+z remain undo/redo).
  // = and + zoom in; - zooms out.
  useHotkeys([
    {
      key: 'z',
      mods: ['shift'],
      handler: () => onToolActiveChange(!toolActive),
    },
    {
      key: '=',
      handler: () => onViewportChange(zoomBy(viewport, ZOOM_STEP)),
    },
    {
      key: '+',
      handler: () => onViewportChange(zoomBy(viewport, ZOOM_STEP)),
    },
    {
      key: '-',
      handler: () => onViewportChange(zoomBy(viewport, 1 / ZOOM_STEP)),
    },
  ]);

  // ── Drag-to-zoom marquee ──────────────────────────────────────────────
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const boxRect = useCallback((): DOMRect | null => {
    return rootRef.current?.getBoundingClientRect() ?? null;
  }, []);

  const onMarqueeDown = useCallback(
    (e: React.PointerEvent) => {
      if (!haveDims) return;
      const box = boxRect();
      if (!box) return;
      e.preventDefault();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      dragStart.current = { x, y };
      setMarquee({ x, y, w: 0, h: 0 });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [haveDims, boxRect],
  );

  const onMarqueeMove = useCallback(
    (e: React.PointerEvent) => {
      const start = dragStart.current;
      const box = boxRect();
      if (!start || !box) return;
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      setMarquee({
        x: Math.min(start.x, cx),
        y: Math.min(start.y, cy),
        w: Math.abs(cx - start.x),
        h: Math.abs(cy - start.y),
      });
    },
    [boxRect],
  );

  const onMarqueeUp = useCallback(() => {
    const box = boxRect();
    const m = marquee;
    dragStart.current = null;
    setMarquee(null);
    if (!box || !m || !haveDims) return;
    const content = computeContentRect(box.width, box.height, frameW, frameH);
    onViewportChange(viewportFromDragRect(viewport, content, m));
  }, [boxRect, marquee, haveDims, frameW, frameH, viewport, onViewportChange]);

  // Change 2: Escape cancels an in-progress marquee drag.
  useEffect(() => {
    if (!marquee) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragStart.current = null;
        setMarquee(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [!!marquee]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Minimap viewfinder ────────────────────────────────────────────────
  const miniCanvasRef = useRef<HTMLCanvasElement>(null);
  // Same letterbox-fit math the canvas/fallback paths use, so the minimap
  // box keeps the frame's aspect ratio.
  const mini = haveDims
    ? computeContentRect(MINIMAP_MAX_W, MINIMAP_MAX_H, frameW, frameH)
    : { x: 0, y: 0, w: MINIMAP_MAX_W, h: MINIMAP_MAX_H };
  const miniW = mini.w;
  const miniH = mini.h;

  // Live thumbnail render loop (only while the minimap is shown).
  useEffect(() => {
    if (!zoomed || !drawThumbnail) return;
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const tick = () => {
      const w = Math.floor(miniW * dpr);
      const h = Math.floor(miniH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawThumbnail(ctx, w, h);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoomed, drawThumbnail, miniW, miniH]);

  const panFromMini = useCallback(
    (e: React.PointerEvent) => {
      const canvas = miniCanvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      onViewportChange(panToFraction(viewport, fx, fy));
    },
    [viewport, onViewportChange],
  );

  const miniDragging = useRef(false);
  const onMiniDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      miniDragging.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panFromMini(e);
    },
    [panFromMini],
  );
  const onMiniMove = useCallback(
    (e: React.PointerEvent) => {
      if (miniDragging.current) panFromMini(e);
    },
    [panFromMini],
  );
  const onMiniUp = useCallback(() => {
    miniDragging.current = false;
  }, []);

  // Visible-region rectangle drawn over the minimap (shared region math).
  const region = regionNorm(viewport);
  const regionStyle: React.CSSProperties = {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.w * 100}%`,
    height: `${region.h * 100}%`,
  };

  // Change 4: 5 buttons × 36 px + 4 gaps × 8 px + 8 px top padding = 220 px.
  const STRIP_H = 5 * 36 + 4 * 8 + 8;
  const shouldWrapButtons = zoomed && containerH > 0 && containerH < STRIP_H + miniH + 24;

  const btn =
    'w-9 h-9 flex items-center justify-center rounded-md border transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div ref={rootRef} className="absolute inset-0 z-20 pointer-events-none">
      {/* Drag-to-zoom marquee capture (only while the tool is armed). */}
      {toolActive && haveDims && (
        <div
          className="absolute inset-0 pointer-events-auto cursor-zoom-in"
          onPointerDown={onMarqueeDown}
          onPointerMove={onMarqueeMove}
          onPointerUp={onMarqueeUp}
          onPointerCancel={onMarqueeUp}
        >
          {marquee && (marquee.w > 1 || marquee.h > 1) && (
            <div
              className="absolute border-2 border-[#e65161] bg-[#e65161]/15"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.w,
                height: marquee.h,
              }}
            />
          )}
        </div>
      )}

      {/* Top-right control strip — reflows to a row when the minimap would overlap. */}
      <div className={`absolute right-2 top-2 flex gap-2 pointer-events-auto z-30 ${shouldWrapButtons ? 'flex-row flex-wrap justify-end' : 'flex-col'}`}>
        <button
          type="button"
          title={tooltips.toggleZoom}
          aria-pressed={zoomed}
          onClick={() => onToggleZoomState?.()}
          className={`${btn} ${
            zoomed
              ? 'bg-[#e65161] border-[#e65161] text-white'
              : 'bg-slate-800/80 border-slate-600 text-slate-200 hover:bg-slate-700'
          }`}
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          title={tooltips.marqueeZoom}
          aria-pressed={toolActive}
          onClick={() => onToolActiveChange(!toolActive)}
          className={`${btn} ${
            toolActive
              ? 'bg-[#e65161] border-[#e65161] text-white'
              : 'bg-slate-800/80 border-slate-600 text-slate-200 hover:bg-slate-700'
          }`}
        >
          <ScanSearch size={18} />
        </button>
        <button
          type="button"
          title={tooltips.zoomIn}
          onClick={() => onViewportChange(zoomBy(viewport, ZOOM_STEP))}
          className={`${btn} bg-slate-800/80 border-slate-600 text-slate-200 hover:bg-slate-700`}
        >
          <ZoomIn size={18} />
        </button>
        <button
          type="button"
          title={tooltips.zoomOut}
          disabled={!zoomed}
          onClick={() => onViewportChange(zoomBy(viewport, 1 / ZOOM_STEP))}
          className={`${btn} bg-slate-800/80 border-slate-600 text-slate-200 hover:bg-slate-700`}
        >
          <ZoomOut size={18} />
        </button>
        <button
          type="button"
          title={tooltips.resetZoom}
          disabled={!zoomed}
          onClick={() => onViewportChange(clampViewport(DEFAULT_VIEWPORT))}
          className={`${btn} bg-slate-800/80 border-slate-600 text-slate-200 hover:bg-slate-700`}
        >
          <Maximize2 size={18} />
        </button>
      </div>

      {/* Bottom-right minimap viewfinder — drag to pan. */}
      {zoomed && haveDims && (
        <div
          className="absolute bottom-2 right-2 pointer-events-auto z-30 rounded-md overflow-hidden border border-slate-500 shadow-lg bg-black/70"
          style={{ width: miniW, height: miniH }}
        >
          <canvas
            ref={miniCanvasRef}
            className="absolute inset-0 w-full h-full cursor-move"
            onPointerDown={onMiniDown}
            onPointerMove={onMiniMove}
            onPointerUp={onMiniUp}
            onPointerCancel={onMiniUp}
          />
          <div
            className="absolute border-2 border-[#e65161] bg-[#e65161]/10 pointer-events-none"
            style={regionStyle}
          />
        </div>
      )}
    </div>
  );
}
