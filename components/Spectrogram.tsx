import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Annotation, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter, VideoMode } from '../types';
import { freqToY, freqAxisTicks } from '../utils/audioProcessing';
import { formatTime, calculateAnnotationLayers, clamp } from '../utils/helpers';
import { chooseTimeStep, formatRulerTime } from '../utils/timeAxis';
import { timeToX, maxScroll as computeMaxScroll, centerScrollLeft } from '../utils/viewportTransform';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { MIN_ZOOM_SEC } from '../constants';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import SelectionHandles from './spectrogram/SelectionHandles';
import FilterHandles from './spectrogram/FilterHandles';
import AnnotationOverlay from './spectrogram/AnnotationOverlay';
import { useChunkRenderer } from '../hooks/useChunkRenderer';
import { useSpectrogramInteraction } from '../hooks/useSpectrogramInteraction';
import { spectrogramView } from '../copy/ui';

interface SpectrogramProps {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  // Playback time arrives via a ref-based pub/sub store (not a prop) so a
  // playback tick redraws the canvas imperatively without re-rendering the tree.
  currentTimeStore: CurrentTimeStore;
  duration: number;
  isPlaying: boolean;
  isProcessing: boolean;
  ident: string | null;
  settings: SpectrogramSettings;
  zoomSec: number;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  // null = Selection Mode (no annotation tool active)
  activeAnnotationTool: AnnotationTool | null;
  annotationTools: AnnotationTool[];
  selection: Selection | null;
  boundAnnotationId: string | null;
  filterToolActive: boolean;
  bandPassFilter: BandPassFilter | null;
  /** Edit-in-place geometry updates (cutoff resize). Does NOT push the stack. */
  onBandPassFilterChange: (f: BandPassFilter | null) => void;
  /** Called when a band is freshly drawn via drag — pushes `filterBand` and engages filtering. */
  onBandPassFilterDrawn: (f: BandPassFilter) => void;
  /** Most recent of {annotationTool, filterTool} in the activation stack, or null. Drives cursor orientation. */
  topTool: 'annotationTool' | 'filterTool' | null;
  onSeek: (time: number) => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onZoomChange: (newZoomSec: number) => void;
  /**
   * Fired on scroll, zoom, and resize with the current time→pixel transform.
   * The single source of truth that the buzzdetect panel consumes for
   * pixel-exact x-alignment with the spectrogram (`x = t*pps − scrollLeft`).
   * Optional so callers that don't need it pay nothing.
   */
  onViewportChange?: (viewport: { scrollLeft: number; pixelsPerSecond: number; containerWidth: number }) => void;
  videoMode?: VideoMode;
  isAudioTrack?: boolean;
  playheadLocked?: boolean;
  hideLabels?: boolean;
}

export interface SpectrogramHandle {
  goToPrevAnnotation: () => void;
  goToNextAnnotation: () => void;
  scrollToTime: (time: number) => void;
  recenterPlayhead: () => void;
  zoomToRange: (startTime: number, endTime: number) => void;
  applyWheel: (deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  focusAnnotationInput: (id: string) => void;
}

// The scroll clamp (40%-of-viewport overrun past the end) lives in
// utils/viewportTransform as `maxScroll`, imported here as `computeMaxScroll`
// so auto-pan, right-drag pan, wheel zoom/pan, and the recenter action all
// share one source of truth.

const Spectrogram = forwardRef<SpectrogramHandle, SpectrogramProps>(({
  chunkCache,
  sampleRate,
  cacheVersion,
  currentTimeStore,
  duration,
  isPlaying,
  isProcessing,
  ident,
  settings,
  zoomSec,
  annotations,
  selectedAnnotationId,
  activeAnnotationTool,
  annotationTools,
  selection,
  boundAnnotationId,
  filterToolActive,
  bandPassFilter,
  onBandPassFilterChange,
  onBandPassFilterDrawn,
  topTool,
  onSeek,
  onAnnotationsChange,
  onAnnotationsCommit,
  onSelectAnnotation,
  onSelectionChange,
  onBoundAnnotationChange,
  onZoomChange,
  onViewportChange,
  videoMode,
  isAudioTrack = false,
  playheadLocked = false,
  hideLabels = false,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!offscreenCanvasRef.current && typeof document !== 'undefined') {
    offscreenCanvasRef.current = document.createElement('canvas');
  }
  // Overlay canvas: draws playhead, time ruler, ident, and selection darkening.
  // Must be above annotation HTML divs (z-30 > annotations z-10/20).
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // Y-axis canvas: separate element to the left of the spectrogram area, never layered on top of spectrogram content.
  const yAxisCanvasRef = useRef<HTMLCanvasElement>(null);

  // Internal scroll state (in pixels)
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollLeftRef = useRef(0);
  // scrollLeftRef is the source of truth, written synchronously by setScroll;
  // the state is a render mirror. There must be NO backward state→ref sync:
  // React commits from different tasks (wheel vs ResizeObserver) can land out
  // of order, and syncing the ref from a stale commit regresses it — the
  // resize handler then re-derives scroll from the regressed ref and re-queues
  // the stale value, producing a self-sustaining two-position oscillation
  // (the "violent jitter" bug). Every scroll write must go through setScroll.
  const setScroll = useCallback((v: number, _source: string = '?') => {
    scrollLeftRef.current = v;
    setScrollLeft(v);
  }, []);
  // Timestamp (ms) of the last user-initiated scroll. Used to suppress auto-scroll
  // for a brief window after manual panning so the two don't fight each other.
  const lastManualScrollRef = useRef(0);

  // Custom cursor position (relative to the spectrogram container)
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [suppressCustomCursor, setSuppressCustomCursor] = useState(false);

  // Hovered annotation id for hover effects (delete button, pencil icon)
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for input focus (pencil icon click)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pencilClickedId, setPencilClickedId] = useState<string | null>(null);
  // Tracks which annotation is currently in text-edit mode (only via pencil)
  const [editingInputId, setEditingInputId] = useState<string | null>(null);

  const handleAnnotationMouseEnter = useCallback((id: string) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHoveredAnnotationId(id);
  }, []);

  const handleAnnotationMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHoveredAnnotationId(null), 300);
  }, []);

  // Focus input when pencil is clicked
  useEffect(() => {
    if (pencilClickedId) {
      inputRefs.current[pencilClickedId]?.focus();
      setPencilClickedId(null);
    }
  }, [pencilClickedId]);

  const requestRef = useRef<number | null>(null);

  // The chunk-rendering buffer pools and incremental-scroll state now live in
  // useChunkRenderer (called below); only the dirty flag + function pointers
  // that the rAF loop drives stay here.

  // Dirty flag: set whenever draw/drawYAxis deps change so the rAF loop only
  // calls the expensive spectrogram render when the background actually changed.
  const drawDirtyRef = useRef(true);
  const drawRef = useRef<() => void>(() => {});
  const drawYAxisRef = useRef<() => void>(() => {});

  // Shared geometry refs read by the render path (drawOverlay, ResizeObserver,
  // autoScroll, applyWheel) AND by the interaction hook's auto-pan loop. Owned
  // here because the scroll/zoom/render code also writes through them; passed
  // into useSpectrogramInteraction so its rAF loop reads them stale-closure-free.
  const pixelsPerSecondRef = useRef(0);
  const durationRef = useRef(duration);

  const [containerWidth, setContainerWidth] = useState(0);

  // True while the visible viewport still has chunks resolving (first load or a
  // settings-driven rebuild). Drives the "building spectrogram" veil. Reconciled
  // inside useChunkRenderer's draw() (which knows the active tier and iterates
  // columns), guarded so setState only fires on an actual transition.
  const [isBuilding, setIsBuilding] = useState(false);

  const pixelsPerSecond = useMemo(() => {
     if (containerWidth === 0) return 100;
     return containerWidth / zoomSec;
  }, [zoomSec, containerWidth]);

  const zoomSecRef = useRef(zoomSec);

  // Keep refs in sync so RAF/window handlers read current values without stale closures.
  pixelsPerSecondRef.current = pixelsPerSecond;
  zoomSecRef.current = zoomSec;
  durationRef.current = duration;

  // --- Interaction Handlers ---
  // The pointer-interaction core (annotation/selection/filter create/resize/drag,
  // click-vs-drag detection, pending-intent refs, the out-of-bounds auto-pan rAF
  // loop, and the window-level mouseup/mousemove handlers) lives in
  // useSpectrogramInteraction. It owns the ~mirror refs that defeat stale closures
  // in those loops/handlers; the shared geometry refs and setScroll are passed in
  // because the scroll/zoom/render path here also writes through them.
  const {
    creatingAnnotation,
    creatingSelection,
    creatingFilter,
    dragStart,
    pendingAnnotationsRef,
    clickDownRef,
    playheadFollowsAnnotationStartRef,
    setResizingAnnotation,
    setResizingSelectionHandle,
    setResizingFilterEdge,
    getPointerTime,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    isAnyDragActiveRef,
  } = useSpectrogramInteraction({
    containerRef,
    scrollLeftRef,
    pixelsPerSecondRef,
    durationRef,
    setScroll,
    scrollLeft,
    pixelsPerSecond,
    duration,
    annotations,
    selection,
    boundAnnotationId,
    activeAnnotationTool,
    isPlaying,
    settings,
    filterToolActive,
    bandPassFilter,
    currentTimeStore,
    onSeek,
    onAnnotationsChange,
    onAnnotationsCommit,
    onSelectAnnotation,
    onSelectionChange,
    onBoundAnnotationChange,
    onBandPassFilterChange,
    onBandPassFilterDrawn,
    setCursorPos,
    setSuppressCustomCursor,
    lastManualScrollRef,
  });

  // Reset scroll position to 0 when switching tracks
  useEffect(() => {
    setScroll(0, 'identReset');
  }, [ident, setScroll]);

  // Publish the time→pixel transform whenever it changes (scroll, zoom, resize).
  // Also fires when `onViewportChange` itself becomes available (e.g. the panel
  // is toggled on) so a freshly-mounted consumer gets the current viewport
  // immediately instead of waiting for the next scroll. AnnotationWindow passes
  // a stable setter, so this never loops.
  useEffect(() => {
    onViewportChange?.({ scrollLeft, pixelsPerSecond, containerWidth });
  }, [onViewportChange, scrollLeft, pixelsPerSecond, containerWidth]);

  // Sync scroll with playback — center the playhead once it reaches the center of the
  // currently-visible window. Disabled when a selection is active: the user positioned
  // the canvas intentionally relative to the selection and auto-scroll disrupts that.
  // Also disabled when the entire file fits in the viewport (zoom ≤ 100%): in that case
  // the playhead can travel the full width of the screen without the view moving.
  //
  // Driven by the currentTime store rather than React state: the store fires its
  // subscribers on each media-clock tick (same cadence as the old per-tick render),
  // and we run the identical centering check imperatively. setScrollLeft only fires
  // when the playhead reaches the visible centre, so this triggers a render only on
  // an actual scroll step — never the whole-tree per-tick render we used to pay.
  // Re-subscribes only when these (infrequently changing) inputs change; reads the
  // live time from the store so the playhead and the scroll stay in lockstep.
  useEffect(() => {
      const autoScroll = () => {
          if (!playheadLocked || !isPlaying || selection || !containerRef.current) return;
          const containerWidth = containerRef.current.clientWidth;
          const pps = pixelsPerSecondRef.current;
          if (duration * pps <= containerWidth) return;
          const t = currentTimeStore.get();
          const targetScroll = t * pps - containerWidth / 2;
          setScroll(Math.max(0, targetScroll), 'autoScroll');
      };
      autoScroll();
      return currentTimeStore.subscribe(autoScroll);
  }, [playheadLocked, isPlaying, currentTimeStore, zoomSec, selection, duration]);

  // Chunk-rendering pipeline (two-stage offscreen build + sub-pixel blit, plus
  // the build-progress veil reconciliation) lives in useChunkRenderer. It owns
  // the reusable buffer pools and incremental-scroll state; we keep storing its
  // `draw` into drawRef and driving it from the rAF loop below.
  const { draw } = useChunkRenderer({
    chunkCache,
    sampleRate,
    cacheVersion,
    scrollLeft,
    pixelsPerSecond,
    duration,
    settings,
    isProcessing,
    canvasRef,
    offscreenCanvasRef,
    setIsBuilding,
  });

  // Overlay canvas: axis, playhead, ident, and selection region darkening.
  // Rendered above annotation HTML divs (z-30).
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Read playback time from the store at draw time — this runs every rAF frame,
    // so the playhead is always the value the media clock produced this frame.
    const currentTime = currentTimeStore.get();

    const dpr = window.devicePixelRatio || 1;
    // Use the container's CSS width rather than canvas.width/dpr to avoid
    // 1-physical-pixel rounding fluctuations that shift tick positions during playback.
    const width = containerRef.current?.clientWidth ?? canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const scrollLeft_live = scrollLeftRef.current;
    const pixelsPerSecond_live = pixelsPerSecondRef.current || pixelsPerSecond;
    const startTime = scrollLeft_live / pixelsPerSecond_live;
    const timePerPixel = 1 / pixelsPerSecond_live;
    const endTime = startTime + (width * timePerPixel);

    // 1. Selection region darkening — draw FIRST so other elements render on top
    // Only show creating-selection darkening once the mouse has moved (not on initial mousedown)
    const isDraggingSelection = creatingSelection && Math.abs(creatingSelection.current - creatingSelection.start) > 0.001;
    const activeSelection = isDraggingSelection
      ? { start: Math.min(creatingSelection.start, creatingSelection.current), end: Math.max(creatingSelection.start, creatingSelection.current) }
      : selection;

    if (activeSelection) {
      const selStartX = Math.max(0, timeToX(activeSelection.start, scrollLeft_live, pixelsPerSecond_live));
      const selEndX = Math.min(width, timeToX(activeSelection.end, scrollLeft_live, pixelsPerSecond_live));

      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      // Left dark region
      if (selStartX > 0) {
        ctx.fillRect(0, 0, selStartX, height);
      }
      // Right dark region
      if (selEndX < width) {
        ctx.fillRect(selEndX, 0, width - selEndX, height);
      }
    }

    // Render in-progress filter creation OR persistent band. The band overlay
    // tracks `bandPassFilter` (the audio source of truth) — tool readiness
    // (`filterToolActive`) only affects whether the cutoff handles are
    // interactive, not whether the band is visible.
    const filterBand = creatingFilter
      ? {
          yTop: Math.min(creatingFilter.y0, creatingFilter.y1),
          yBottom: Math.max(creatingFilter.y0, creatingFilter.y1),
          strength: bandPassFilter?.strength ?? 1,
        }
      : bandPassFilter
      ? {
          yTop: freqToY(bandPassFilter.high, height, settings.minFreq, settings.maxFreq, settings.frequencyScale),
          yBottom: freqToY(bandPassFilter.low, height, settings.minFreq, settings.maxFreq, settings.frequencyScale),
          strength: bandPassFilter.strength,
        }
      : null;

    // In Fast mode the filter has no effect on audio, so don't render it.
    // For audio tracks, AudioEngine always handles playback with decoded PCM so
    // the filter always applies — treat as 'accurate' regardless of videoMode.
    // For video tracks in Fast mode the filter has no effect; in Mixed mode without
    // a selection the video element's audio track plays instead of AudioEngine.
    const filterInactive = !isAudioTrack && (videoMode === 'fast' || (videoMode === 'mixed' && !selection));
    if (filterBand && !filterInactive) {
      const darkAlpha = 0.5 * filterBand.strength;
      ctx.fillStyle = `rgba(0, 0, 0, ${darkAlpha})`;
      if (filterBand.yTop > 0) {
        ctx.fillRect(0, 0, width, filterBand.yTop);
      }
      if (filterBand.yBottom < height) {
        ctx.fillRect(0, filterBand.yBottom, width, height - filterBand.yBottom);
      }
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, filterBand.yTop); ctx.lineTo(width, filterBand.yTop);
      ctx.moveTo(0, filterBand.yBottom); ctx.lineTo(width, filterBand.yBottom);
      ctx.stroke();
    } else if (filterBand && !isAudioTrack && videoMode === 'mixed' && !selection) {
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, filterBand.yTop); ctx.lineTo(width, filterBand.yTop);
      ctx.moveTo(0, filterBand.yBottom); ctx.lineTo(width, filterBand.yBottom);
      ctx.stroke();
    }

    // 2. Draw Playhead Line
    const playheadX = timeToX(currentTime, scrollLeft_live, pixelsPerSecond_live);
    if (playheadX >= 0 && playheadX <= width) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
    }

    // 3. Draw Time Ruler
    // Choose tick spacing from the stable configured span (zoomSec), NOT from
    // endTime-startTime. The latter is derived from the live clientWidth, which
    // fluctuates by sub-pixel amounts during playback/panning. At round zoom
    // levels the visible span sits exactly on a timeStep threshold (e.g. 10s),
    // so those tiny fluctuations flip timeStep between 1 and 2 — making the
    // odd-second labels flicker in and out. zoomSec is the same value
    // pixelsPerSecond is derived from (pixelsPerSecond = containerWidth/zoomSec),
    // so the span across the container is exactly zoomSec.
    const timeRange = zoomSec;
    const timeStep = chooseTimeStep(timeRange);

    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const tickEndTime = duration > 0 ? Math.min(endTime, duration) : endTime;
    const firstTimeTick = Math.floor(startTime / timeStep) * timeStep;
    for (let s = firstTimeTick; s <= tickEndTime; s += timeStep) {
        if (s <= 0) continue;
        const x = timeToX(s, scrollLeft_live, pixelsPerSecond_live);
        if (x >= 0 && x <= width) {
            ctx.beginPath();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.moveTo(x, height);
            ctx.lineTo(x, height - 8);
            ctx.stroke();

            const timeStr = formatRulerTime(s, timeStep, timeRange);
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 3;
            ctx.strokeText(timeStr, x, height - 10);
            ctx.fillStyle = 'white';
            ctx.fillText(timeStr, x, height - 10);
        }
    }

    // 5. Draw ident text at top of spectrogram
    if (ident) {
      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(ident, 8, 6);
    }

    ctx.restore();
  }, [scrollLeft, pixelsPerSecond, zoomSec, currentTimeStore, ident, selection, creatingSelection, duration, creatingFilter, bandPassFilter, videoMode, isAudioTrack, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Y-axis canvas: draws the frequency axis. Separate from the spectrogram area so it is never layered on top.
  const drawYAxis = useCallback(() => {
    const canvas = yAxisCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(0, 0, width, height);

    // Right border line
    ctx.beginPath();
    ctx.moveTo(width - 1, 0);
    ctx.lineTo(width - 1, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    let lastLabelY: number | null = null;
    const MIN_LABEL_SPACING = 13;

    const renderTick = (freq: number) => {
      // Use the shared freq→y mapping so axis labels stay in exact lockstep
      // with the spectrogram renderer (same function, no drift).
      const y = freqToY(freq, height, settings.minFreq, settings.maxFreq, settings.frequencyScale);

      if (y < 0 || y > height) return;
      if (lastLabelY !== null && Math.abs(y - lastLabelY) < MIN_LABEL_SPACING) return;
      lastLabelY = y;

      ctx.beginPath();
      ctx.moveTo(width - 5, y);
      ctx.lineTo(width - 1, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();

      let label = freq.toString();
      if (freq >= 1000) {
        label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
      }
      ctx.fillText(label, width - 7, y);
    };

    for (const freq of freqAxisTicks(settings.minFreq, settings.maxFreq, settings.frequencyScale)) {
      renderTick(freq);
    }
    ctx.restore();
  }, [settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Keep drawRef/drawYAxisRef current and mark dirty whenever the spectrogram
  // background needs a redraw (scroll, zoom, data, settings changed).
  // useLayoutEffect so the flag is set before the useEffect below can read it.
  useLayoutEffect(() => {
    drawRef.current = draw;
    drawYAxisRef.current = drawYAxis;
    drawDirtyRef.current = true;
  }, [draw, drawYAxis]);

  // The overlay (playhead/selection/ruler) must animate every frame during
  // playback, but playback time no longer flows through React state — so we can't
  // rely on a per-render effect to reschedule the frame. Instead a single
  // self-scheduling rAF loop runs for the component's lifetime and repaints each
  // layer only when its dirty flag is set:
  //   • drawDirty  — expensive spectrogram background (scroll/zoom/data/settings)
  //   • overlayDirty — cheap overlay (playhead moved, selection/filter changed)
  // When idle both flags stay clear and the loop costs two boolean checks/frame.
  const drawOverlayRef = useRef(drawOverlay);
  const overlayDirtyRef = useRef(true);
  useLayoutEffect(() => {
    drawOverlayRef.current = drawOverlay;
    overlayDirtyRef.current = true;
  }, [drawOverlay]);

  // Each media-clock tick marks the overlay dirty so the loop repaints the
  // playhead on the next frame — same cadence as the old per-tick state render,
  // but without re-rendering the React tree.
  useEffect(
    () => currentTimeStore.subscribe(() => { overlayDirtyRef.current = true; }),
    [currentTimeStore],
  );

  useEffect(() => {
    const tick = () => {
      if (drawDirtyRef.current) {
        drawRef.current();
        drawYAxisRef.current();
        drawDirtyRef.current = false;
      }
      if (overlayDirtyRef.current) {
        drawOverlayRef.current();
        overlayDirtyRef.current = false;
      }
      requestRef.current = requestAnimationFrame(tick);
    };
    requestRef.current = requestAnimationFrame(tick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // Handle Resize — keep all canvases in sync with their container dimensions
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        const newWidth = Math.max(1, width);
        // Preserve the left-edge time across resize: scrollLeft is in pixels and
        // pixelsPerSecond = containerWidth / zoomSec, so a width change would shift
        // the visible time range unless we rescale scrollLeft proportionally.
        if (pixelsPerSecondRef.current > 0 && zoomSecRef.current > 0) {
          const leftEdgeTime = scrollLeftRef.current / pixelsPerSecondRef.current;
          const newPps = newWidth / zoomSecRef.current;
          const newScrollLeft = leftEdgeTime * newPps;
          setScroll(newScrollLeft, 'resize');
        }
        setContainerWidth(newWidth);
        const dpr = window.devicePixelRatio || 1;
        if (canvasRef.current) {
          canvasRef.current.width = Math.max(1, Math.round(newWidth * dpr));
          canvasRef.current.height = Math.max(1, Math.round(height * dpr));
        }
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.width = newWidth * dpr;
          overlayCanvasRef.current.height = height * dpr;
        }
        if (yAxisCanvasRef.current) {
          yAxisCanvasRef.current.width = 50 * dpr;
          yAxisCanvasRef.current.height = height * dpr;
        }
        draw();
        drawOverlay();
        drawYAxis();
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [draw, drawOverlay, drawYAxis]);

  // --- Annotation navigation ---

  const sortedAnnotations = useMemo(() => [...annotations].sort((a, b) => a.start - b.start), [annotations]);

  const scrollToAnnotation = useCallback((annotStart: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const targetScrollLeft = (annotStart * pixelsPerSecond) - (containerWidth * 0.25);
    setScroll(Math.max(0, targetScrollLeft), 'scrollToAnnotation');
  }, [pixelsPerSecond, setScroll]);

  const goToPrevAnnotation = useCallback(() => {
    if (selection !== null) {
      const t = currentTimeStore.get();
      if (Math.abs(t - selection.start) <= 0.05) {
        // Second press: already at selection start — clear selection and fall through to prev annotation
        onSelectionChange(null);
        onBoundAnnotationChange(null);
      } else {
        // First press: jump to selection start
        onSeek(selection.start);
        scrollToAnnotation(selection.start);
        return;
      }
    }
    const prev = [...sortedAnnotations].reverse().find(a => a.start < currentTimeStore.get() - 0.05);
    if (prev) {
      onSeek(prev.start);
      scrollToAnnotation(prev.start);
    } else {
      onSeek(0);
      scrollToAnnotation(0);
    }
  }, [sortedAnnotations, currentTimeStore, onSeek, scrollToAnnotation, selection, onSelectionChange, onBoundAnnotationChange]);

  const goToNextAnnotation = useCallback(() => {
    // Any active selection (free or bound): jump to selection end
    if (selection !== null) {
      onSeek(selection.end);
      scrollToAnnotation(selection.end);
      return;
    }
    const next = sortedAnnotations.find(a => a.start > currentTimeStore.get() + 0.05);
    if (next) {
      onSeek(next.start);
      scrollToAnnotation(next.start);
    } else {
      onSeek(duration);
      scrollToAnnotation(duration);
    }
  }, [sortedAnnotations, currentTimeStore, duration, onSeek, scrollToAnnotation, selection]);

  const scrollToTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    setScroll(centerScrollLeft(time, pixelsPerSecond, containerWidth, duration), 'scrollToTime');
  }, [pixelsPerSecond, duration, setScroll]);

  // Recenter the playhead in the visible window without changing zoom.
  const recenterPlayhead = useCallback(() => {
    scrollToTime(currentTimeStore.get());
  }, [scrollToTime, currentTimeStore]);

  // Escape handling lives in AnnotationWindow (universal activation-stack
  // unwind). When `Esc` pops `selection`, AnnotationWindow also clears
  // boundAnnotationId, so this component no longer registers an Esc binding.


  const applyWheel = useCallback((deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => {
    if (ctrlKey || metaKey) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const containerWidth = containerRef.current.clientWidth;
      const currentPps = containerWidth / zoomSec;
      const timeAtMouse = (scrollLeft + mouseX) / currentPps;
      const zoomFactor = 1.25;
      // Trackpad inertia tails deliver horizontal-only events (deltaY === 0).
      // `deltaY > 0 ? 1 : -1` would treat every one of those as a zoom-in step,
      // making the view zoom by itself while Ctrl is held after a pan gesture.
      if (deltaY === 0) return;
      const direction = deltaY > 0 ? 1 : -1;
      let newZoomSec = zoomSec * (direction > 0 ? zoomFactor : 1 / zoomFactor);
      newZoomSec = Math.max(MIN_ZOOM_SEC, Math.min(newZoomSec, duration ? duration * 1.4 : 86400));
      const newPixelsPerSecond = containerWidth / newZoomSec;
      let newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;
      const maxScroll = computeMaxScroll(duration, newPixelsPerSecond, containerWidth);
      newScrollLeft = clamp(newScrollLeft, 0, maxScroll);
      setScroll(newScrollLeft, 'zoom');
      onZoomChange(newZoomSec);
    } else {
      const panAmount = deltaY + deltaX;
      const containerWidth = containerRef.current?.clientWidth || 0;
      const maxScroll = computeMaxScroll(duration, pixelsPerSecond, containerWidth);
      lastManualScrollRef.current = Date.now();
      setScroll(clamp(scrollLeftRef.current + panAmount, 0, maxScroll), 'wheel');
    }
  }, [zoomSec, scrollLeft, duration, pixelsPerSecond, onZoomChange]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    applyWheel(e.deltaX, e.deltaY, e.ctrlKey, e.metaKey, e.clientX);
  };

  const zoomToRange = useCallback((startTime: number, endTime: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const newZoomSec = Math.max(MIN_ZOOM_SEC, endTime - startTime);
    const newPps = containerWidth / newZoomSec;
    const maxScroll = computeMaxScroll(duration, newPps, containerWidth);
    setScroll(clamp(startTime * newPps, 0, maxScroll), 'zoomToRange');
    onZoomChange(newZoomSec);
  }, [duration, onZoomChange, setScroll]);

  const zoomIn = useCallback(() => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const rect = containerRef.current.getBoundingClientRect();
    applyWheel(0, -100, true, false, rect.left + containerWidth / 2);
  }, [applyWheel]);

  const zoomOut = useCallback(() => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const rect = containerRef.current.getBoundingClientRect();
    applyWheel(0, 100, true, false, rect.left + containerWidth / 2);
  }, [applyWheel]);

  useImperativeHandle(ref, () => ({
    goToPrevAnnotation,
    goToNextAnnotation,
    scrollToTime,
    recenterPlayhead,
    zoomToRange,
    applyWheel,
    zoomIn,
    zoomOut,
    focusAnnotationInput: (id: string) => {
      inputRefs.current[id]?.focus();
    },
  }), [goToPrevAnnotation, goToNextAnnotation, scrollToTime, recenterPlayhead, zoomToRange, applyWheel, zoomIn, zoomOut]);

  const layeredAnnotations = useMemo(() => calculateAnnotationLayers(annotations), [annotations]);

  // Overlay for annotation being created (annotation tool mode)
  const renderCreatingOverlay = () => {
    if (!creatingAnnotation || activeAnnotationTool === null) return null;
    const s = Math.min(creatingAnnotation.start, creatingAnnotation.current);
    const eTime = Math.max(creatingAnnotation.start, creatingAnnotation.current);
    const left = timeToX(s, scrollLeft, pixelsPerSecond);
    const width = ((eTime - s) * pixelsPerSecond);

    return (
        <div
            className="absolute top-0 bottom-0 bg-white/20 border-l border-r border-white/50 pointer-events-none"
            style={{ left: `${left}px`, width: `${width}px` }}
        >
            <span className="absolute -top-6 left-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(s)}</span>
            <span className="absolute -top-6 right-0 text-xs bg-black/80 px-1 rounded text-white">{formatTime(eTime)}</span>
        </div>
    );
  };

  return (
    <div className="flex w-full h-full bg-slate-900 overflow-hidden select-none">
      {/* Y-axis canvas — separate element to the left of the spectrogram, never layered on top */}
      <canvas ref={yAxisCanvasRef} className="h-full flex-shrink-0 pointer-events-none" style={{ width: 50 }} />

      {/* Spectrogram area — all interactive content lives here */}
      <div
          ref={containerRef}
          className="relative flex-1 h-full overflow-hidden cursor-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setCursorPos(null);
            // Don't terminate the drag — window mouseup handler cleans up when the button is released.
            // Only end non-drag interactions (e.g. right-click pan) on leave.
            if (!isAnyDragActiveRef.current) handleMouseUp();
          }}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
      >
      {/* Build-in-progress veil — rendered BEHIND the spectrogram canvas so it
          shows through only on columns that have no chunk data yet (the canvas
          leaves those transparent via colMask). Built chunks are opaque and fully
          occlude the sweep. Suppressed during initial decode. */}
      {isBuilding && !isProcessing && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <style>{`@keyframes spectroBuildSweep { 0% { transform: translateY(-100%); } 100% { transform: translateY(200%); } }`}</style>
          <div
            className="absolute inset-x-0"
            style={{
              height: '40%',
              background: 'linear-gradient(180deg, transparent 0%, rgba(230,81,97,0.30) 45%, rgba(230,81,97,0.50) 50%, rgba(230,81,97,0.30) 55%, transparent 100%)',
              animation: 'spectroBuildSweep 1.6s linear infinite',
            }}
          />
        </div>
      )}

      {/* Layer 1: spectrogram canvas — above the veil, transparent on unbuilt columns */}
      <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />

      {/* Blurred placeholder overlay during initial spectrogram generation (decode phase) */}
      {isProcessing && (
        <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              background: 'repeating-linear-gradient(180deg, rgba(71,85,105,0.35) 0px, rgba(30,41,59,0.2) 6px, rgba(51,65,85,0.3) 6px, rgba(15,23,42,0.15) 14px)',
              filter: 'blur(6px)',
              transform: 'scale(1.06)',
            }}
          />
          <div className="absolute inset-0 bg-slate-900/60" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-slate-400 text-xs bg-slate-900/70 px-3 py-1 rounded tracking-wide">{spectrogramView.generating}</span>
          </div>
        </div>
      )}

      {/* Layer 2: annotation HTML divs and selection handles */}
      <div className="absolute top-0 left-0 w-full h-full">
         <AnnotationOverlay
           layeredAnnotations={layeredAnnotations}
           annotations={annotations}
           selectedAnnotationId={selectedAnnotationId}
           boundAnnotationId={boundAnnotationId}
           hoveredAnnotationId={hoveredAnnotationId}
           editingInputId={editingInputId}
           annotationTools={annotationTools}
           selection={selection}
           settings={settings}
           scrollLeft={scrollLeft}
           pixelsPerSecond={pixelsPerSecond}
           containerWidth={containerRef.current?.clientWidth || 1000}
           hideLabels={hideLabels}
           currentTimeStore={currentTimeStore}
           inputRefs={inputRefs}
           pendingAnnotationsRef={pendingAnnotationsRef}
           clickDownRef={clickDownRef}
           playheadFollowsAnnotationStartRef={playheadFollowsAnnotationStartRef}
           getPointerTime={getPointerTime}
           onSelectAnnotation={onSelectAnnotation}
           onAnnotationsChange={onAnnotationsChange}
           onAnnotationsCommit={onAnnotationsCommit}
           onBoundAnnotationChange={onBoundAnnotationChange}
           onSelectionChange={onSelectionChange}
           onAnnotationMouseEnter={handleAnnotationMouseEnter}
           onAnnotationMouseLeave={handleAnnotationMouseLeave}
           setEditingInputId={setEditingInputId}
           setPencilClickedId={setPencilClickedId}
           setResizingAnnotation={setResizingAnnotation}
         />

         {/* Creating annotation overlay (annotation tool mode) */}
         {renderCreatingOverlay()}

         {/* Selection region handles */}
         <SelectionHandles
           selection={selection}
           creatingSelection={creatingSelection}
           scrollLeft={scrollLeft}
           pixelsPerSecond={pixelsPerSecond}
           containerWidth={containerRef.current?.clientWidth ?? 1000}
           onBeginResize={setResizingSelectionHandle}
         />

         {/* Band-pass filter cutoff handles */}
         <FilterHandles
           bandPassFilter={bandPassFilter}
           creatingFilter={creatingFilter}
           settings={settings}
           containerHeight={containerRef.current?.clientHeight ?? 0}
           onBeginResize={setResizingFilterEdge}
         />
      </div>

      {/* Layer 3: overlay canvas — playhead, time ruler, ident, selection darkening.
          z-30 keeps it above annotation HTML divs (z-10/20) and below nav buttons (z-50). */}
      <canvas
        ref={overlayCanvasRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{ zIndex: 30 }}
      />

      {/* ToolCursor — z-40, above overlay canvas. A single bar whose
          orientation reflects the topmost tool: vertical for Select /
          annotation tools (time-axis drags), horizontal for the filter tool
          (frequency-axis drags). High-contrast white fill with 1px dark
          outline for readability over bright spectrogram regions. */}
      {cursorPos && !suppressCustomCursor && (() => {
        const isFilter = topTool === 'filterTool';
        const w = isFilter ? 24 : 2;
        const h = isFilter ? 2 : 24;
        return (
          <div
            className="absolute pointer-events-none"
            style={{ left: cursorPos.x, top: cursorPos.y, zIndex: 40, transform: 'translate(-50%, -50%)' }}
          >
            <div
              style={{
                width: w,
                height: h,
                background: 'white',
                outline: '1px solid rgba(0,0,0,0.85)',
                outlineOffset: 0,
              }}
            />
            {/* Tool name — only shown when an annotation tool is active. */}
            {!isFilter && activeAnnotationTool && (
              <div
                className="absolute whitespace-nowrap text-[10px] leading-none font-medium"
                style={{
                  // Sit below the 24px cursor bar (bottom at +12 from centre) plus ~0.75ch
                  // of breathing room so the vertical cursor and the label never overlap.
                  top: 24,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  color: activeAnnotationTool.color,
                  textShadow: '0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)',
                }}
              >
                {activeAnnotationTool.key === '0' ? 'Custom' : activeAnnotationTool.text}
              </div>
            )}
          </div>
        );
      })()}

      </div>{/* end spectrogram area */}
    </div>
  );
});

Spectrogram.displayName = 'Spectrogram';

export default Spectrogram;
