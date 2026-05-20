import React, { useRef, useEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Annotation, AnnotationWithLayer, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter } from '../types';
import { drawSpectrogramChunk, yToFreq, freqToY } from '../utils/audioProcessing';
import { formatTime, calculateAnnotationLayers, makeAnnotationFromTool } from '../utils/helpers';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { MIN_ZOOM_SEC, DRAG_INTENT_HOLD_MS } from '../constants';
import { X, Pencil } from 'lucide-react';

// Format time for the spectrogram ruler.
// viewSpan: the total visible time range in seconds (used to decide whether to show hours).
function formatRulerTime(s: number, timeStep: number, viewSpan: number): string {
  if (timeStep < 1) {
    return `${s.toFixed(2)}s`;
  }
  const totalSec = Math.round(s);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;

  const showHours = viewSpan >= 3600;

  if (showHours) {
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  } else if (totalSec >= 60 || timeStep >= 60) {
    return `${m}m${String(sec).padStart(2, '0')}s`;
  } else {
    return `${sec}s`;
  }
}

interface SpectrogramProps {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  currentTime: number;
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
  onSelectionCommit?: (region: Selection) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onZoomChange: (newZoomSec: number) => void;
}

export interface SpectrogramHandle {
  goToPrevAnnotation: () => void;
  goToNextAnnotation: () => void;
  scrollToTime: (time: number) => void;
}

// Helpers for scale mapping (duplicated locally for Y-axis calculation)
const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);

const Spectrogram = forwardRef<SpectrogramHandle, SpectrogramProps>(({
  chunkCache,
  sampleRate,
  cacheVersion,
  currentTime,
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
  onSelectionCommit,
  onBoundAnnotationChange,
  onZoomChange
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
  const interactionRef = useRef<HTMLDivElement>(null);

  // Internal scroll state (in pixels)
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollLeftRef = useRef(0);
  useEffect(() => { scrollLeftRef.current = scrollLeft; }, [scrollLeft]);
  const [dragStart, setDragStart] = useState<{ x: number; scroll: number } | null>(null);

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

  // Interaction State (annotations — only when activeAnnotationTool !== null)
  const [creatingAnnotation, setCreatingAnnotation] = useState<{ start: number; current: number } | null>(null);
  const [resizingAnnotation, setResizingAnnotation] = useState<{ id: string; side: 'start' | 'end'; originalTime: number } | null>(null);
  const [draggedAnnotation, setDraggedAnnotation] = useState<{ id: string; startOffset: number } | null>(null);

  // Selection Mode interaction state
  const [creatingSelection, setCreatingSelection] = useState<{ start: number; current: number } | null>(null);
  const [resizingSelectionHandle, setResizingSelectionHandle] = useState<'start' | 'end' | null>(null);

  // Filter tool interaction state
  const [creatingFilter, setCreatingFilter] = useState<{ y0: number; y1: number } | null>(null);
  const [resizingFilterEdge, setResizingFilterEdge] = useState<'low' | 'high' | null>(null);

  // Annotation-bound selection state is lifted to App.tsx (boundAnnotationId prop + onBoundAnnotationChange).

  // Track mousedown on annotation center to distinguish click vs drag
  const clickDownRef = useRef<{ x: number; y: number; annotationId: string; pointerTime: number } | null>(null);

  // Pending drag intent: recorded at mousedown but not promoted to visible state until
  // the pointer has moved ≥1% of the canvas width OR been held ≥DRAG_INTENT_HOLD_MS.
  // Using refs (not state) so no re-render/gray-out happens until the threshold is crossed.
  const pendingSelectionRef = useRef<{ start: number; startX: number; startTime: number } | null>(null);
  const pendingAnnotationRef = useRef<{ start: number; startX: number; startTime: number } | null>(null);

  const requestRef = useRef<number | null>(null);
  const pendingAnnotationsRef = useRef<Annotation[]>(annotations);

  // Refs for out-of-bounds drag handling (auto-pan + window-level events)
  // These mirror state/props so the RAF loop can read them without stale closures.
  const pixelsPerSecondRef = useRef(0);
  const durationRef = useRef(duration);
  const creatingSelectionRef = useRef(creatingSelection);
  const creatingAnnotationRef = useRef(creatingAnnotation);
  const resizingAnnotationRef = useRef(resizingAnnotation);
  const draggedAnnotationRef = useRef(draggedAnnotation);
  const resizingSelectionHandleRef = useRef(resizingSelectionHandle);
  const annotationsRef = useRef(annotations);
  const boundAnnotationIdRef = useRef(boundAnnotationId);
  const selectionRef = useRef(selection);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onAnnotationsChangeRef = useRef(onAnnotationsChange);
  const mousePosRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const autoPanRafRef = useRef<number | null>(null);

  const [containerWidth, setContainerWidth] = useState(0);

  const pixelsPerSecond = useMemo(() => {
     if (containerWidth === 0) return 100;
     return containerWidth / zoomSec;
  }, [zoomSec, containerWidth]);

  const zoomSecRef = useRef(zoomSec);

  // Keep refs in sync so RAF/window handlers read current values without stale closures.
  pixelsPerSecondRef.current = pixelsPerSecond;
  zoomSecRef.current = zoomSec;
  durationRef.current = duration;
  creatingSelectionRef.current = creatingSelection;
  creatingAnnotationRef.current = creatingAnnotation;
  resizingAnnotationRef.current = resizingAnnotation;
  draggedAnnotationRef.current = draggedAnnotation;
  resizingSelectionHandleRef.current = resizingSelectionHandle;
  annotationsRef.current = annotations;
  boundAnnotationIdRef.current = boundAnnotationId;
  selectionRef.current = selection;
  onSelectionChangeRef.current = onSelectionChange;
  onAnnotationsChangeRef.current = onAnnotationsChange;

  // Reset scroll position to 0 when switching tracks
  useEffect(() => {
    setScrollLeft(0);
  }, [ident]);

  // Sync scroll with playback — center the playhead once it reaches the center of the
  // currently-visible window. Disabled when a selection is active: the user positioned
  // the canvas intentionally relative to the selection and auto-scroll disrupts that.
  // Also disabled when the entire file fits in the viewport (zoom ≤ 100%): in that case
  // the playhead can travel the full width of the screen without the view moving.
  useEffect(() => {
      if (isPlaying && !selection && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const pps = pixelsPerSecondRef.current;
          if (duration * pps <= containerWidth) return;
          const curScroll = scrollLeftRef.current;
          const visibleCenterTime = (curScroll + containerWidth / 2) / pps;
          if (currentTime >= visibleCenterTime) {
              const targetScroll = currentTime * pps - containerWidth / 2;
              setScrollLeft(Math.max(0, targetScroll));
          }
      }
  }, [isPlaying, currentTime, zoomSec, selection, duration]);

  // Main canvas: draws spectrogram data only.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!canvas || !offscreen) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.width / dpr;   // canvas.width is now in physical px (see resize)

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const startTime = scrollLeft / pixelsPerSecond;
    const endTime = startTime + cssWidth / pixelsPerSecond;

    if (chunkCache && duration > 0) {
        // ── Two-stage spectrogram rendering pipeline ────────────────────────
        // Stage 1 (THIS BLOCK): build a column-resolution viewport buffer
        // (one entry per STFT column, no time-axis discretization here) and
        // render it into an offscreen canvas at native column resolution.
        //
        // Stage 2: ctx.drawImage with sub-pixel destination shift lets the
        // browser bilinearly resample the offscreen canvas onto the visible
        // canvas. Smooth sub-pixel scrolling works because dx is fractional;
        // no aliasing pattern can lock to the canvas pixel grid.
        //
        // Stage 2b (drawSpectrogramChunk in utils/audioProcessing.ts): handles
        // frequency-axis remap (linear/log/mel), contrast, brightness, and
        // colormap. It still does no time-axis remapping — specWidth always
        // equals the offscreen canvas width.
        //
        // Pixel ↔ time coordinate system used everywhere else in the app:
        //     time = (scrollLeft + xCss) / pixelsPerSecond
        // Annotations, playhead, ticks all compute their position with this
        // formula. The drawImage destination math matches it exactly so the
        // spectrogram and overlays stay locked in time.
        const visibleDuration = endTime - startTime;
        const activeTier = chunkCache.selectTier(visibleDuration, cssWidth);
        chunkCache.prefetchViewport(startTime, endTime, activeTier.tier);

        // Probe one chunk for nFreqBins (same as before).
        let nFreqBins = settings.fftSize / 2;
        {
          const probe = chunkCache.getChunkWithFallback(startTime, activeTier.tier);
          if (probe) nFreqBins = probe.chunk.nFreqBins;
        }

        // The "global" cps used for the offscreen-canvas grid. Use the active tier's
        // colsPerSec — fallback chunks at coarser tiers will be resampled by nearest-
        // col lookup into this grid.
        const cps = activeTier.colsPerSec;

        // Compute the offscreen backbuffer extent. One offscreen pixel per STFT
        // column at the active tier. Add 1-col margin on each side so sub-pixel
        // drawImage shift never reads past the buffer.
        const bbStartCol = Math.floor(startTime * cps) - 1;
        const bbEndCol   = Math.ceil(endTime * cps) + 1;
        const bbWidth = Math.max(1, bbEndCol - bbStartCol);
        const bbStartTime = bbStartCol / cps;

        // Build the column-resolution viewport buffer.
        const viewportData = new Uint16Array(bbWidth * nFreqBins);
        for (let i = 0; i < bbWidth; i++) {
          const absCol = bbStartCol + i;
          if (absCol < 0) continue;                // before file start
          const t = absCol / cps;
          if (t >= duration) continue;             // past file end
          const result = chunkCache.getChunkWithFallback(t, activeTier.tier);
          if (!result) continue;
          const { chunk } = result;
          if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) continue;

          // Map t into a column index inside this chunk. After the Rust-side
          // cps-drift fix (audio.rs), chunk.nCols / chunk.actualDurationSec equals
          // the chunk's true cps, so this is exact for STFT chunks. Overview
          // chunks (sampled at evenly spaced points) use their own ratio.
          const chunkCps = chunk.nCols / chunk.actualDurationSec;
          let col = Math.round((t - chunk.startSec) * chunkCps);
          if (col < 0) col = 0;
          if (col >= chunk.nCols) col = chunk.nCols - 1;

          const bins = Math.min(nFreqBins, chunk.nFreqBins);
          const srcOffset = col * chunk.nFreqBins;
          const dstOffset = i * nFreqBins;
          viewportData.set(chunk.data.subarray(srcOffset, srcOffset + bins), dstOffset);
        }

        // Render the column-resolution image into the offscreen canvas.
        // Offscreen canvas gets one pixel per column horizontally and matches the
        // visible canvas's physical-pixel height (so vertical resolution stays sharp).
        if (offscreen.width !== bbWidth) offscreen.width = bbWidth;
        if (offscreen.height !== canvas.height) offscreen.height = canvas.height;
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;
        drawSpectrogramChunk(
          offCtx, viewportData, bbWidth, nFreqBins,
          offscreen.width, offscreen.height,
          settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
          settings.displayFloor, settings.displayCeil,
        );

        // Blit offscreen → visible canvas with sub-pixel destination shift.
        // dxPhys / dwPhys are in physical pixels (canvas.width is in physical px).
        const dxCss = (bbStartTime - startTime) * pixelsPerSecond;
        const dwCss = bbWidth / cps * pixelsPerSecond;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(offscreen, 0, 0, bbWidth, offscreen.height,
                      dxCss * dpr, 0, dwCss * dpr, canvas.height);

        // Paint end-of-file region with the background color so it's distinct
        // from zero-value spectrogram data.
        const endXCss = Math.ceil((duration - startTime) * pixelsPerSecond);
        if (endXCss < cssWidth) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(endXCss * dpr, 0, (cssWidth - endXCss) * dpr, canvas.height);
        }
    } else if (!chunkCache && duration > 0 && !isProcessing) {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        for (let i = 0; i < canvas.width; i += 50 * dpr) {
          ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height);
        }
        ctx.stroke();
        ctx.fillStyle = '#334155';
        ctx.font = `bold ${24 * dpr}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Spectrogram Unavailable', canvas.width / 2, canvas.height / 2);
    }
  }, [chunkCache, sampleRate, cacheVersion, scrollLeft, pixelsPerSecond, duration, settings.fftSize, settings.minFreq, settings.maxFreq, settings.frequencyScale, settings.displayFloor, settings.displayCeil, isProcessing]);

  // Overlay canvas: axis, playhead, ident, and selection region darkening.
  // Rendered above annotation HTML divs (z-30).
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Use the container's CSS width rather than canvas.width/dpr to avoid
    // 1-physical-pixel rounding fluctuations that shift tick positions during playback.
    const width = containerRef.current?.clientWidth ?? canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const startTime = scrollLeft / pixelsPerSecond;
    const timePerPixel = 1 / pixelsPerSecond;
    const endTime = startTime + (width * timePerPixel);

    // 1. Selection region darkening — draw FIRST so other elements render on top
    // Only show creating-selection darkening once the mouse has moved (not on initial mousedown)
    const isDraggingSelection = creatingSelection && Math.abs(creatingSelection.current - creatingSelection.start) > 0.001;
    const activeSelection = isDraggingSelection
      ? { start: Math.min(creatingSelection.start, creatingSelection.current), end: Math.max(creatingSelection.start, creatingSelection.current) }
      : selection;

    if (activeSelection) {
      const selStartX = Math.max(0, (activeSelection.start * pixelsPerSecond) - scrollLeft);
      const selEndX = Math.min(width, (activeSelection.end * pixelsPerSecond) - scrollLeft);

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

    if (filterBand) {
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
    }

    // 2. Draw Playhead Line
    const playheadX = (currentTime * pixelsPerSecond) - scrollLeft;
    if (playheadX >= 0 && playheadX <= width) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
    }

    // 3. Draw Time Ruler
    const timeRange = endTime - startTime;
    let timeStep = 1;
    if (timeRange > 36000) timeStep = 3600;
    else if (timeRange > 7200) timeStep = 600;
    else if (timeRange > 1200) timeStep = 120;
    else if (timeRange > 300) timeStep = 60;
    else if (timeRange > 60) timeStep = 10;
    else if (timeRange > 30) timeStep = 5;
    else if (timeRange > 10) timeStep = 2;
    else if (timeRange > 2) timeStep = 1;
    else timeStep = 0.25;

    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const tickEndTime = duration > 0 ? Math.min(endTime, duration) : endTime;
    const firstTimeTick = Math.floor(startTime / timeStep) * timeStep;
    for (let s = firstTimeTick; s <= tickEndTime; s += timeStep) {
        if (s <= 0) continue;
        const x = (s * pixelsPerSecond) - scrollLeft;
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
  }, [scrollLeft, pixelsPerSecond, currentTime, ident, selection, creatingSelection, duration, creatingFilter, bandPassFilter, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

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
      let y = 0;
      if (settings.frequencyScale === 'linear') {
        const pct = (freq - settings.minFreq) / (settings.maxFreq - settings.minFreq);
        y = height - (pct * height);
      } else if (settings.frequencyScale === 'log') {
        const minSafe = Math.max(settings.minFreq, 1);
        const pct = Math.log(freq / minSafe) / Math.log(settings.maxFreq / minSafe);
        y = height - (pct * height);
      } else if (settings.frequencyScale === 'mel') {
        const minM = toMel(settings.minFreq);
        const maxM = toMel(settings.maxFreq);
        const m = toMel(freq);
        const pct = (m - minM) / (maxM - minM);
        y = height - (pct * height);
      }

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

    if (settings.frequencyScale === 'log') {
      let mag = 10;
      while (mag < settings.maxFreq) {
        [1, 2, 5].forEach(mult => {
          const freq = mag * mult;
          if (freq >= settings.minFreq && freq <= settings.maxFreq) renderTick(freq);
        });
        mag *= 10;
      }
    } else {
      const range = settings.maxFreq - settings.minFreq;
      if (range > 0) {
        const roughStep = range / 8;
        const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
        let step = magnitude;
        if (roughStep / step > 5) step *= 5;
        else if (roughStep / step > 2) step *= 2;
        const firstTick = Math.ceil(settings.minFreq / step) * step;
        for (let freq = firstTick; freq <= settings.maxFreq; freq += step) {
          renderTick(freq);
        }
      }
    }
    ctx.restore();
  }, [settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(() => { draw(); drawOverlay(); drawYAxis(); });
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [draw, drawOverlay, drawYAxis]);

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
          scrollLeftRef.current = newScrollLeft;
          setScrollLeft(newScrollLeft);
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

  const canGoPrev = sortedAnnotations.length > 0 && sortedAnnotations.some(a => a.start < currentTime - 0.05);
  const canGoNext = sortedAnnotations.length > 0 && sortedAnnotations.some(a => a.start > currentTime + 0.05);

  const scrollToAnnotation = useCallback((annotStart: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const targetScrollLeft = (annotStart * pixelsPerSecond) - (containerWidth * 0.25);
    setScrollLeft(Math.max(0, targetScrollLeft));
  }, [pixelsPerSecond]);

  const goToPrevAnnotation = useCallback(() => {
    // Any active selection (free or bound): jump to selection start
    if (selection !== null) {
      onSeek(selection.start);
      scrollToAnnotation(selection.start);
      return;
    }
    const prev = [...sortedAnnotations].reverse().find(a => a.start < currentTime - 0.05);
    if (prev) {
      onSeek(prev.start);
      scrollToAnnotation(prev.start);
    } else {
      onSeek(0);
      scrollToAnnotation(0);
    }
  }, [sortedAnnotations, currentTime, onSeek, scrollToAnnotation, selection]);

  const goToNextAnnotation = useCallback(() => {
    // Any active selection (free or bound): jump to selection end
    if (selection !== null) {
      onSeek(selection.end);
      scrollToAnnotation(selection.end);
      return;
    }
    const next = sortedAnnotations.find(a => a.start > currentTime + 0.05);
    if (next) {
      onSeek(next.start);
      scrollToAnnotation(next.start);
    } else {
      onSeek(duration);
      scrollToAnnotation(duration);
    }
  }, [sortedAnnotations, currentTime, duration, onSeek, scrollToAnnotation, selection]);

  const scrollToTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    setScrollLeft(Math.max(0, time * pixelsPerSecond - containerWidth / 2));
  }, [pixelsPerSecond]);

  useImperativeHandle(ref, () => ({
    goToPrevAnnotation,
    goToNextAnnotation,
    scrollToTime,
  }), [goToPrevAnnotation, goToNextAnnotation, scrollToTime]);

  // Escape handling lives in AnnotationWindow (universal activation-stack
  // unwind). When `Esc` pops `selection`, AnnotationWindow also clears
  // boundAnnotationId, so this component no longer registers an Esc binding.

  // --- Interaction Handlers ---

  // Shared: create an annotation from the active tool, commit it, and enter annotation-bound selection state.
  const commitNewAnnotation = useCallback((start: number, end: number) => {
    if (!activeAnnotationTool) return;
    const newAnnotation = makeAnnotationFromTool(activeAnnotationTool, start, end);
    onAnnotationsCommit([...annotations, newAnnotation]);
    onSelectAnnotation(newAnnotation.id);
    onBoundAnnotationChange(newAnnotation.id);
    onSelectionChange({ start, end });
  }, [activeAnnotationTool, annotations, onAnnotationsCommit, onSelectAnnotation, onBoundAnnotationChange, onSelectionChange]);

  const getPointerTime = (e: React.MouseEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const absoluteX = x + scrollLeft;
    const t = absoluteX / pixelsPerSecond;
    return Math.max(0, Math.min(t, duration));
  };

  // Updates drag state using only refs — safe to call from a RAF loop or window handler.
  const processDragAtClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(
      (clientX - rect.left + scrollLeftRef.current) / pixelsPerSecondRef.current,
      durationRef.current
    ));

    const ca = creatingAnnotationRef.current;
    if (ca) { setCreatingAnnotation({ ...ca, current: t }); return; }

    const cs = creatingSelectionRef.current;
    if (cs) {
      setCreatingSelection({ ...cs, current: t });
      const liveStart = Math.min(cs.start, t);
      const liveEnd = Math.max(cs.start, t);
      onSelectionChangeRef.current({ start: liveStart, end: liveEnd });
      return;
    }

    const ra = resizingAnnotationRef.current;
    if (ra) {
      const updated = annotationsRef.current.map(a => {
        if (a.id !== ra.id) return a;
        if (ra.side === 'start') return { ...a, start: Math.min(t, a.end - 0.05) };
        return { ...a, end: Math.max(t, a.start + 0.05) };
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChangeRef.current(updated);
      if (ra.id === boundAnnotationIdRef.current) {
        const updated2 = updated.find(a => a.id === ra.id);
        if (updated2) onSelectionChangeRef.current({ start: updated2.start, end: updated2.end });
      }
      return;
    }

    const da = draggedAnnotationRef.current;
    if (da) {
      const updated = annotationsRef.current.map(a => {
        if (a.id !== da.id) return a;
        const dur = a.end - a.start;
        const newStart = Math.max(0, Math.min(t - da.startOffset, durationRef.current - dur));
        return { ...a, start: newStart, end: newStart + dur };
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChangeRef.current(updated);
      return;
    }

    const rsh = resizingSelectionHandleRef.current;
    const sel = selectionRef.current;
    if (rsh && sel) {
      let newStart = sel.start;
      let newEnd = sel.end;
      if (rsh === 'start') newStart = Math.min(t, sel.end - 0.05);
      else newEnd = Math.max(t, sel.start + 0.05);
      onSelectionChangeRef.current({ start: newStart, end: newEnd });
      if (boundAnnotationIdRef.current) {
        const updated = annotationsRef.current.map(a =>
          a.id === boundAnnotationIdRef.current ? { ...a, start: newStart, end: newEnd } : a
        );
        pendingAnnotationsRef.current = updated;
        onAnnotationsChangeRef.current(updated);
      }
    }
  }, []); // reads only from refs — stable

  // Whether any selection/annotation drag is currently active
  const isAnyDragActive =
    creatingSelection !== null || creatingAnnotation !== null ||
    resizingAnnotation !== null || draggedAnnotation !== null ||
    resizingSelectionHandle !== null;

  // Keep a ref so window handlers can check without a stale closure
  const isAnyDragActiveRef = useRef(isAnyDragActive);
  isAnyDragActiveRef.current = isAnyDragActive;

  // Filter drags are vertical only — kept out of isAnyDragActive so they don't trigger
  // the horizontal auto-pan, but still tracked for the window-level mouseup handler.
  const isFilterDragActive = creatingFilter !== null || resizingFilterEdge !== null;
  const isFilterDragActiveRef = useRef(isFilterDragActive);
  isFilterDragActiveRef.current = isFilterDragActive;

  // Always track mouse position so the RAF can use it even when mouse is outside the spectrogram
  useEffect(() => {
    const trackMouse = (e: MouseEvent) => { mousePosRef.current = { clientX: e.clientX, clientY: e.clientY }; };
    window.addEventListener('mousemove', trackMouse, { passive: true });
    return () => window.removeEventListener('mousemove', trackMouse);
  }, []);

  // While a filter drag is active, track mouse moves at window level so the drag
  // continues even if the pointer leaves the spectrogram container vertically.
  useEffect(() => {
    if (!isFilterDragActive) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const canvasHeight = container.clientHeight;
      const localY = Math.max(0, Math.min(canvasHeight, e.clientY - rect.top));

      if (resizingFilterEdge !== null && bandPassFilter) {
        const freq = yToFreq(localY, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        if (resizingFilterEdge === 'low') {
          const newLow = Math.min(freq, bandPassFilter.high - 1);
          onBandPassFilterChange({ ...bandPassFilter, low: Math.max(settings.minFreq, newLow) });
        } else {
          const newHigh = Math.max(freq, bandPassFilter.low + 1);
          onBandPassFilterChange({ ...bandPassFilter, high: Math.min(settings.maxFreq, newHigh) });
        }
      } else if (creatingFilter !== null) {
        setCreatingFilter({ ...creatingFilter, y1: localY });
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isFilterDragActive, creatingFilter, resizingFilterEdge, bandPassFilter, settings.minFreq, settings.maxFreq, settings.frequencyScale, onBandPassFilterChange]);

  // Re-sync pendingAnnotationsRef when the annotations prop changes externally (e.g. undo/redo).
  // If a drag is in flight, discard any pending edit — the undo intentionally rewinds state.
  useEffect(() => {
    if (!isAnyDragActive) {
      pendingAnnotationsRef.current = annotations;
    }
  }, [annotations, isAnyDragActive]);

  // Prevent text selection in all panels while a drag is in progress
  useEffect(() => {
    if (!isAnyDragActive) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => { document.body.style.userSelect = prev; };
  }, [isAnyDragActive]);

  // Auto-pan: while a drag is active and the mouse is outside the spectrogram bounds,
  // scroll the view and update the drag endpoint based on mouse overflow distance.
  useEffect(() => {
    if (!isAnyDragActive) return;

    const tick = () => {
      const pos = mousePosRef.current;
      const container = containerRef.current;
      if (pos && container) {
        const rect = container.getBoundingClientRect();
        const containerWidth = rect.width;
        const pps = pixelsPerSecondRef.current;
        const dur = durationRef.current;
        let overflow = 0;

        const da = draggedAnnotationRef.current;
        if (da) {
          // For annotation drags, trigger auto-pan based on where the annotation edge
          // would land given the current mouse position — not where the mouse itself is.
          // This way panning starts the moment the annotation boundary reaches the viewport
          // edge, even while the mouse is still inside.
          const ann = annotationsRef.current.find(a => a.id === da.id);
          if (ann) {
            const annotDur = ann.end - ann.start;
            const mouseRelX = pos.clientX - rect.left;
            const desiredStartPx = mouseRelX - da.startOffset * pps;
            const desiredEndPx = mouseRelX + (annotDur - da.startOffset) * pps;
            if (desiredStartPx < 0) overflow = desiredStartPx;
            else if (desiredEndPx > containerWidth) overflow = desiredEndPx - containerWidth;
          }
        } else {
          if (pos.clientX < rect.left) overflow = pos.clientX - rect.left;       // negative → pan left
          else if (pos.clientX > rect.right) overflow = pos.clientX - rect.right; // positive → pan right
        }

        if (overflow !== 0) {
          const absOverflow = Math.abs(overflow);
          // Gentle acceleration: slow start (~1px/frame at edge), ramps up, capped at 40px/frame
          const speed = Math.sign(overflow) * Math.min(Math.pow(absOverflow / 40, 1.5), 40);
          const overrunPixels = containerWidth * 0.4;
          const maxScroll = Math.max(0, dur * pps - containerWidth + overrunPixels);
          const newScroll = Math.max(0, Math.min(scrollLeftRef.current + speed, maxScroll));

          if (Math.abs(newScroll - scrollLeftRef.current) > 0.01) {
            scrollLeftRef.current = newScroll;
            setScrollLeft(newScroll);
            const da = draggedAnnotationRef.current;
            if (da) {
              // Pin the appropriate boundary to the visible edge so the annotation
              // stays fully visible: start→left edge when panning left, end→right edge when panning right.
              const viewLeft = newScroll / pps;
              const viewRight = (newScroll + containerWidth) / pps;
              const updated = annotationsRef.current.map(a => {
                if (a.id !== da.id) return a;
                const annotDur = a.end - a.start;
                const newStart = overflow < 0
                  ? Math.max(0, viewLeft)
                  : Math.max(0, Math.min(viewRight - annotDur, dur - annotDur));
                return { ...a, start: newStart, end: newStart + annotDur };
              });
              pendingAnnotationsRef.current = updated;
              onAnnotationsChangeRef.current(updated);
              if (da.id === boundAnnotationIdRef.current) {
                const moved = updated.find(a => a.id === da.id);
                if (moved) onSelectionChangeRef.current({ start: moved.start, end: moved.end });
              }
            } else {
              processDragAtClientX(pos.clientX);
            }
          }
        }
      }
      autoPanRafRef.current = requestAnimationFrame(tick);
    };

    autoPanRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (autoPanRafRef.current) { cancelAnimationFrame(autoPanRafRef.current); autoPanRafRef.current = null; }
    };
  }, [isAnyDragActive, processDragAtClientX]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      setDragStart({ x: e.clientX, scroll: scrollLeft });
      return;
    }

    if ((e.target as HTMLElement).closest('input') || (e.target as HTMLElement).closest('button')) return;

    if (filterToolActive) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const y = e.clientY - rect.top;
      setCreatingFilter({ y0: y, y1: y });
      return;
    }

    const annotationItem = (e.target as HTMLElement).closest('.annotation-item');
    if (!annotationItem) {
      // Clicking bare spectrogram
      const t = getPointerTime(e);

      // Shift+click while paused: extend/create from playhead to click point
      if (e.shiftKey && !isPlaying) {
        const selStart = Math.min(currentTime, t);
        const selEnd = Math.max(currentTime, t);
        if (selEnd - selStart > 0.001) {
          if (activeAnnotationTool === null) {
            onSelectionChange({ start: selStart, end: selEnd });
          } else {
            commitNewAnnotation(selStart, selEnd);
          }
        }
        return;
      }

      // Click inside existing selection: seek, then allow drag to replace it
      if (selection && t >= selection.start && t <= selection.end) {
        onSeek(t);
        if (activeAnnotationTool === null) {
          pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
        } else {
          pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
        }
        return;
      }

      // Click outside selection: clear state, seek, record pending drag intent
      onSelectAnnotation(null);
      onBoundAnnotationChange(null);
      onSelectionChange(null);
      onSeek(t);
      if (activeAnnotationTool === null) {
        pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
      } else {
        pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
      }
    }
    // Annotation center clicks are handled in the annotation onMouseDown handler
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    mousePosRef.current = { clientX: e.clientX, clientY: e.clientY };
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const computedCursor = elUnder ? window.getComputedStyle(elUnder).cursor : 'none';
    setSuppressCustomCursor(computedCursor !== 'none');

    if (dragStart) {
      const delta = dragStart.x - e.clientX;
      const containerWidth = containerRef.current?.clientWidth || 0;
      const overrunPixels = containerWidth * 0.4;
      const maxScroll = Math.max(0, (duration * pixelsPerSecond) - containerWidth + overrunPixels);
      setScrollLeft(Math.max(0, Math.min(dragStart.scroll + delta, maxScroll)));
      return;
    }

    if (resizingFilterEdge !== null && bandPassFilter) {
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const rectY = containerRef.current?.getBoundingClientRect().top ?? 0;
      const localY = Math.max(0, Math.min(canvasHeight, e.clientY - rectY));
      const freq = yToFreq(localY, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
      if (resizingFilterEdge === 'low') {
        const newLow = Math.min(freq, bandPassFilter.high - 1);
        onBandPassFilterChange({ ...bandPassFilter, low: Math.max(settings.minFreq, newLow) });
      } else {
        const newHigh = Math.max(freq, bandPassFilter.low + 1);
        onBandPassFilterChange({ ...bandPassFilter, high: Math.min(settings.maxFreq, newHigh) });
      }
      return;
    }

    if (creatingFilter !== null) {
      const rectY = containerRef.current?.getBoundingClientRect().top ?? 0;
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const y = Math.max(0, Math.min(canvasHeight, e.clientY - rectY));
      setCreatingFilter({ ...creatingFilter, y1: y });
      return;
    }

    const t = getPointerTime(e);

    // Check if we should convert a pending annotation click into a drag
    if (clickDownRef.current) {
      const dx = e.clientX - clickDownRef.current.x;
      const dy = e.clientY - clickDownRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 5) {
        // Convert to drag
        const dragAnnotation = annotations.find(a => a.id === clickDownRef.current!.annotationId);
        if (dragAnnotation) {
          setDraggedAnnotation({ id: clickDownRef.current.annotationId, startOffset: clickDownRef.current.pointerTime - dragAnnotation.start });
        }
        clickDownRef.current = null;
      }
      return;
    }

    // Promote pending drag intents once the pointer has moved far enough or been held long enough
    const containerWidth = containerRef.current?.clientWidth || 0;
    const thresholdPx = containerWidth * 0.01;

    if (pendingAnnotationRef.current) {
      const dx = Math.abs(e.clientX - pendingAnnotationRef.current.startX);
      const heldMs = Date.now() - pendingAnnotationRef.current.startTime;
      if (dx >= thresholdPx || heldMs >= DRAG_INTENT_HOLD_MS) {
        onSelectAnnotation(null);
        onBoundAnnotationChange(null);
        onSelectionChange(null);
        setCreatingAnnotation({ start: pendingAnnotationRef.current.start, current: t });
        pendingAnnotationRef.current = null;
      }
      return;
    }

    if (pendingSelectionRef.current) {
      const dx = Math.abs(e.clientX - pendingSelectionRef.current.startX);
      const heldMs = Date.now() - pendingSelectionRef.current.startTime;
      if (dx >= thresholdPx || heldMs >= DRAG_INTENT_HOLD_MS) {
        onSelectAnnotation(null);
        onBoundAnnotationChange(null);
        onSelectionChange(null);
        setCreatingSelection({ start: pendingSelectionRef.current.start, current: t });
        pendingSelectionRef.current = null;
      }
      return;
    }

    if (creatingAnnotation) {
      setCreatingAnnotation({ ...creatingAnnotation, current: t });
      return;
    }

    if (creatingSelection) {
      setCreatingSelection({ ...creatingSelection, current: t });
      const liveStart = Math.min(creatingSelection.start, t);
      const liveEnd = Math.max(creatingSelection.start, t);
      onSelectionChange({ start: liveStart, end: liveEnd });
      return;
    }

    if (resizingAnnotation) {
      const updated = annotations.map(a => {
        if (a.id === resizingAnnotation.id) {
          if (resizingAnnotation.side === 'start') return { ...a, start: Math.min(t, a.end - 0.05) };
          return { ...a, end: Math.max(t, a.start + 0.05) };
        }
        return a;
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChange(updated);
      // If resizing a bound annotation, update selection region to match
      if (resizingAnnotation.id === boundAnnotationId) {
        const updatedAnnotation = updated.find(a => a.id === resizingAnnotation.id);
        if (updatedAnnotation) {
          onSelectionChange({ start: updatedAnnotation.start, end: updatedAnnotation.end });
        }
      }
      return;
    }

    if (draggedAnnotation) {
       const pps = pixelsPerSecondRef.current;
       const viewLeft = scrollLeftRef.current / pps;
       const viewRight = (scrollLeftRef.current + (containerRef.current?.clientWidth ?? 0)) / pps;
       const updated = annotations.map(a => {
           if (a.id === draggedAnnotation.id) {
               const dur = a.end - a.start;
               const desired = t - draggedAnnotation.startOffset;
               // Clamp so neither edge exits the visible viewport (auto-pan handles scrolling).
               const newStart = Math.max(0, Math.max(viewLeft, Math.min(desired, Math.min(durationRef.current - dur, viewRight - dur))));
               return { ...a, start: newStart, end: newStart + dur };
           }
           return a;
       });
       pendingAnnotationsRef.current = updated;
       onAnnotationsChange(updated);
       if (boundAnnotationId === draggedAnnotation.id) {
         const moved = updated.find(a => a.id === draggedAnnotation.id);
         if (moved) onSelectionChange({ start: moved.start, end: moved.end });
       }
       return;
    }

    if (resizingSelectionHandle && selection) {
      let newStart = selection.start;
      let newEnd = selection.end;
      if (resizingSelectionHandle === 'start') {
        newStart = Math.min(t, selection.end - 0.05);
      } else {
        newEnd = Math.max(t, selection.start + 0.05);
      }
      onSelectionChange({ start: newStart, end: newEnd });
      // If there's a bound annotation, update its extent to match
      if (boundAnnotationId) {
        const updated = annotations.map(a => {
          if (a.id === boundAnnotationId) return { ...a, start: newStart, end: newEnd };
          return a;
        });
        pendingAnnotationsRef.current = updated;
        onAnnotationsChange(updated);
      }
    }
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    if (dragStart) setDragStart(null);

    if (resizingFilterEdge !== null) {
      setResizingFilterEdge(null);
      return;
    }

    if (creatingFilter !== null) {
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const yTop = Math.min(creatingFilter.y0, creatingFilter.y1);
      const yBottom = Math.max(creatingFilter.y0, creatingFilter.y1);
      if (yBottom - yTop > 5 && canvasHeight > 0) {
        const high = yToFreq(yTop, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        const low = yToFreq(yBottom, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        // Fresh drag → auto-engage filtering and push the `filterBand` stack
        // entry. Pure edit-in-place geometry (cutoff resize) still uses
        // onBandPassFilterChange and does NOT touch the stack.
        onBandPassFilterDrawn({ low, high, strength: bandPassFilter?.strength ?? 1 });
      }
      setCreatingFilter(null);
      return;
    }

    // Pending annotation click (no significant movement) → annotation-bound selection
    if (clickDownRef.current) {
      const annotation = annotations.find(a => a.id === clickDownRef.current!.annotationId);
      if (annotation) {
        onBoundAnnotationChange(annotation.id);
        onSelectionChange({ start: annotation.start, end: annotation.end });
        onSelectAnnotation(annotation.id);
      }
      clickDownRef.current = null;
    }

    // If the drag never crossed the threshold, discard the pending intent (treat as plain click)
    pendingAnnotationRef.current = null;
    pendingSelectionRef.current = null;

    if (creatingAnnotation) {
      const start = Math.min(creatingAnnotation.start, creatingAnnotation.current);
      const end = Math.max(creatingAnnotation.start, creatingAnnotation.current);
      if (end > start && activeAnnotationTool !== null) {
        commitNewAnnotation(start, end);
      }
      setCreatingAnnotation(null);
    }

    if (creatingSelection) {
      const start = Math.min(creatingSelection.start, creatingSelection.current);
      const end = Math.max(creatingSelection.start, creatingSelection.current);
      if (end > start) {
        onSelectionChange({ start, end });
        onSelectionCommit?.({ start, end });
        onBoundAnnotationChange(null);
      } else {
        onSelectionChange(null);
      }
      setCreatingSelection(null);
    }

    if (resizingAnnotation) {
      onAnnotationsCommit(pendingAnnotationsRef.current);
      setResizingAnnotation(null);
    }

    if (draggedAnnotation) {
      onAnnotationsCommit(pendingAnnotationsRef.current);
      setDraggedAnnotation(null);
    }

    if (resizingSelectionHandle) {
      if (boundAnnotationId && pendingAnnotationsRef.current.length > 0) {
        onAnnotationsCommit(pendingAnnotationsRef.current);
      }
      setResizingSelectionHandle(null);
    }
  };

  // Handle mouseup outside the spectrogram (e.g. mouse released over another panel).
  // handleMouseUpRef is reassigned to the latest handleMouseUp on every render, so the
  // window-level handler always sees the most recent state — no stale-closure risk.
  const handleMouseUpRef = useRef(handleMouseUp);
  handleMouseUpRef.current = handleMouseUp;
  useEffect(() => {
    const onWindowMouseUp = () => {
      if (isAnyDragActiveRef.current || isFilterDragActiveRef.current) handleMouseUpRef.current();
    };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => window.removeEventListener('mouseup', onWindowMouseUp);
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        if (!containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const containerWidth = containerRef.current.clientWidth;

        // Compute timeAtMouse from live DOM dimensions (not the potentially-stale
        // pixelsPerSecond closure value) so the anchor stays exact on every tick.
        const currentPps = containerWidth / zoomSec;
        const timeAtMouse = (scrollLeft + mouseX) / currentPps;

        const zoomFactor = 1.1;
        const direction = e.deltaY > 0 ? 1 : -1;

        let newZoomSec = zoomSec * (direction > 0 ? zoomFactor : 1 / zoomFactor);
        newZoomSec = Math.max(MIN_ZOOM_SEC, Math.min(newZoomSec, duration ? duration * 1.4 : 86400));

        const newPixelsPerSecond = containerWidth / newZoomSec;

        // Keep timeAtMouse under the same pixel after zoom:
        // newScrollPx = timeAtMouse * newPixelsPerSecond - mousePxFromCanvasLeft
        let newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;
        // Allow scrolling 40% of the view past the end of the file so the user can
        // center late events or zoom out with the end visible.
        const overrunPixels = containerWidth * 0.4;
        const maxScroll = Math.max(0, (duration * newPixelsPerSecond) - containerWidth + overrunPixels);
        newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScroll));

        setScrollLeft(newScrollLeft);
        onZoomChange(newZoomSec);
      } else {
          const panAmount = e.deltaY + e.deltaX;
          const containerWidth = containerRef.current?.clientWidth || 0;
          const overrunPixels = containerWidth * 0.4;
          const maxScroll = Math.max(0, (duration * pixelsPerSecond) - containerWidth + overrunPixels);
          setScrollLeft(prev => Math.max(0, Math.min(prev + panAmount, maxScroll)));
      }
  };

  const layeredAnnotations = useMemo(() => calculateAnnotationLayers(annotations), [annotations]);

  // Overlay for annotation being created (annotation tool mode)
  const renderCreatingOverlay = () => {
    if (!creatingAnnotation || activeAnnotationTool === null) return null;
    const s = Math.min(creatingAnnotation.start, creatingAnnotation.current);
    const eTime = Math.max(creatingAnnotation.start, creatingAnnotation.current);
    const left = (s * pixelsPerSecond) - scrollLeft;
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

  // Render selection region handles (draggable)
  const renderSelectionHandles = () => {
    const activeSelection = selection;
    if (!activeSelection || creatingSelection) return null;

    const leftX = (activeSelection.start * pixelsPerSecond) - scrollLeft;
    const rightX = (activeSelection.end * pixelsPerSecond) - scrollLeft;
    const containerWidth = containerRef.current?.clientWidth ?? 1000;

    return (
      <>
        {/* Left handle — 1px white line with slightly wider invisible hit area */}
        {leftX >= 0 && leftX <= containerWidth && (
          <div
            className="absolute top-0 bottom-0 cursor-ew-resize"
            style={{ left: `${leftX - 4}px`, width: '9px', zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingSelectionHandle('start');
            }}
          >
            <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: '4px' }} />
          </div>
        )}
        {/* Right handle — 1px white line with slightly wider invisible hit area */}
        {rightX >= 0 && rightX <= containerWidth && (
          <div
            className="absolute top-0 bottom-0 cursor-ew-resize"
            style={{ left: `${rightX - 4}px`, width: '9px', zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingSelectionHandle('end');
            }}
          >
            <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: '4px' }} />
          </div>
        )}
      </>
    );
  };

  // Render horizontal cutoff handles for the band-pass filter.
  const renderFilterHandles = () => {
    if (!filterToolActive || !bandPassFilter || creatingFilter) return null;
    const canvasHeight = containerRef.current?.clientHeight ?? 0;
    if (canvasHeight === 0) return null;

    const yHigh = freqToY(bandPassFilter.high, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
    const yLow = freqToY(bandPassFilter.low, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);

    return (
      <>
        {yHigh >= 0 && yHigh <= canvasHeight && (
          <div
            className="absolute left-0 right-0 cursor-ns-resize"
            style={{ top: `${yHigh - 4}px`, height: '9px', zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingFilterEdge('high');
            }}
          >
            <div className="absolute left-0 right-0" style={{ top: '4px', height: '1px', background: '#60a5fa' }} />
          </div>
        )}
        {yLow >= 0 && yLow <= canvasHeight && (
          <div
            className="absolute left-0 right-0 cursor-ns-resize"
            style={{ top: `${yLow - 4}px`, height: '9px', zIndex: 15 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setResizingFilterEdge('low');
            }}
          >
            <div className="absolute left-0 right-0" style={{ top: '4px', height: '1px', background: '#60a5fa' }} />
          </div>
        )}
      </>
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
      {/* Layer 1: spectrogram canvas (bottom) */}
      <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />

      {/* Blurred placeholder overlay during spectrogram generation */}
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
            <span className="text-slate-400 text-xs bg-slate-900/70 px-3 py-1 rounded tracking-wide">Generating spectrogram…</span>
          </div>
        </div>
      )}

      {/* Layer 2: annotation HTML divs and selection handles */}
      <div ref={interactionRef} className="absolute top-0 left-0 w-full h-full">
         {layeredAnnotations.map((annotation) => {
             const left = (annotation.start * pixelsPerSecond) - scrollLeft;
             const width = (annotation.end - annotation.start) * pixelsPerSecond;
             const isSelected = selectedAnnotationId === annotation.id;
             const isBound = boundAnnotationId === annotation.id;

             if (left + width < 0 || left > (containerRef.current?.clientWidth || 1000)) return null;

             const top = 22 + (annotation.layerIndex * 35);

             const baseColor = annotation.color || "#ffffff";
             const isWhite = baseColor.toLowerCase() === "#ffffff" || baseColor.toLowerCase() === "#fff";

             const styleVars = isWhite ? {
                 borderColor: isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.8)',
                 bgColor: isSelected ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.15)',
                 textColor: '#ffffff'
             } : {
                 borderColor: baseColor,
                 bgColor: isSelected ? `${baseColor}99` : `${baseColor}66`,
                 textColor: baseColor
             };

             const isHovered = hoveredAnnotationId === annotation.id;

             return (
                 <div
                    key={annotation.id}
                    className="annotation-item absolute rounded transition-colors duration-200"
                    style={{
                        left: `${left}px`,
                        width: `${Math.max(2, width)}px`,
                        top: `${top}px`,
                        height: '30px',
                        border: `${isBound ? '2px' : '1px'} solid ${isBound ? 'white' : styleVars.borderColor}`,
                        backgroundColor: styleVars.bgColor,
                        boxShadow: isBound ? '0 0 0 2px rgba(255,255,255,0.4)' : '0 2px 4px rgba(0,0,0,0.5)',
                        zIndex: isSelected ? 20 : 10
                    }}
                    onMouseEnter={() => handleAnnotationMouseEnter(annotation.id)}
                    onMouseLeave={handleAnnotationMouseLeave}
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        // Middle Click Delete
                        if (e.button === 1) {
                            e.preventDefault();
                            onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                            if (isSelected) onSelectAnnotation(null);
                            if (boundAnnotationId === annotation.id) {
                              onBoundAnnotationChange(null);
                              onSelectionChange(null);
                            }
                            return;
                        }
                        onSelectAnnotation(annotation.id);
                        // Track for click vs drag detection
                        clickDownRef.current = { x: e.clientX, y: e.clientY, annotationId: annotation.id, pointerTime: getPointerTime(e) };
                    }}
                 >
                    {/* Left resize handle */}
                    <div
                        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            clickDownRef.current = null;
                            onSelectAnnotation(annotation.id);
                            setResizingAnnotation({ id: annotation.id, side: 'start', originalTime: annotation.start });
                        }}
                    >
                        {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>
                    {/* Right resize handle */}
                    <div
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            clickDownRef.current = null;
                            onSelectAnnotation(annotation.id);
                            setResizingAnnotation({ id: annotation.id, side: 'end', originalTime: annotation.end });
                        }}
                    >
                        {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
                    </div>

                    {width > 30 ? (
                        <input
                            ref={(el) => { inputRefs.current[annotation.id] = el; }}
                            type="text"
                            value={annotation.text}
                            onChange={(e) => {
                                const newText = e.target.value;
                                const newAnnotations = annotations.map(a => {
                                    if (a.id === annotation.id) {
                                        const matchingTool = annotationTools.find(t => t.text.toLowerCase() === newText.toLowerCase() && t.key !== "0");
                                        if (matchingTool) {
                                             return { ...a, text: matchingTool.text, toolKey: matchingTool.key, color: matchingTool.color };
                                        }
                                        if (a.toolKey !== "0" && a.color !== "#ffffff" && a.text !== newText) {
                                            return { ...a, text: newText, toolKey: "0", color: "#ffffff" };
                                        }
                                        return { ...a, text: newText };
                                    }
                                    return a;
                                });
                                pendingAnnotationsRef.current = newAnnotations;
                                onAnnotationsChange(newAnnotations);
                            }}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') {
                                    onSelectAnnotation(null);
                                    (e.target as HTMLInputElement).blur();
                                }
                                if (e.key === 'Escape') {
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                            onBlur={() => {
                                setEditingInputId(null);
                                if (annotation.text.trim() === "") {
                                    const filtered = annotations.filter(a => a.id !== annotation.id);
                                    onAnnotationsCommit(filtered);
                                    onSelectAnnotation(null);
                                } else {
                                    onAnnotationsCommit(pendingAnnotationsRef.current);
                                }
                            }}
                            className="absolute left-2 right-2 top-0 bottom-0 bg-transparent text-xs placeholder-white/30 focus:outline-none"
                            style={{
                                color: '#ffffff',
                                fontWeight: 'bold',
                                textShadow: '0 1px 2px black',
                                // Only allow pointer interaction when editing via pencil or for new empty annotations
                                pointerEvents: (editingInputId === annotation.id || (isSelected && annotation.text === '')) ? 'auto' : 'none'
                            }}
                            placeholder="Name..."
                            onMouseDown={(e) => {
                                if (e.button === 1) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                                    if (isSelected) onSelectAnnotation(null);
                                    return;
                                }
                                e.stopPropagation();
                            }}
                            autoFocus={isSelected && annotation.text === ""}
                        />
                    ) : null}

                    {/* Pencil icon — appears on hover, click to focus text input */}
                    {isHovered && (
                      width > 60 ? (
                        // Render inside the annotation
                        <button
                          className="absolute top-0 bottom-0 right-5 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
                          onMouseEnter={() => handleAnnotationMouseEnter(annotation.id)}
                          onMouseLeave={handleAnnotationMouseLeave}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingInputId(annotation.id);
                            setPencilClickedId(annotation.id);
                          }}
                          data-tooltip="Edit annotation name"
                        >
                          <Pencil size={10} className="text-white drop-shadow" />
                        </button>
                      ) : (
                        // Render outside to the right (floats above adjacent annotations)
                        <button
                          className="absolute flex items-center justify-center bg-slate-800/90 rounded p-0.5 hover:bg-slate-700 transition-colors"
                          style={{ left: `${Math.max(2, width) + 2}px`, top: '4px', zIndex: 50 }}
                          onMouseEnter={() => handleAnnotationMouseEnter(annotation.id)}
                          onMouseLeave={handleAnnotationMouseLeave}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingInputId(annotation.id);
                            setPencilClickedId(annotation.id);
                          }}
                          data-tooltip="Edit annotation name"
                        >
                          <Pencil size={10} className="text-white" />
                        </button>
                      )
                    )}

                    {/* Delete button */}
                    <button
                        className={`absolute -top-3 -right-3 ${isHovered ? 'flex' : 'hidden'} bg-red-500 rounded-full p-0.5 z-30`}
                        onMouseEnter={() => handleAnnotationMouseEnter(annotation.id)}
                        onMouseLeave={handleAnnotationMouseLeave}
                        onClick={(e) => {
                            e.stopPropagation();
                            onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                            if (isSelected) onSelectAnnotation(null);
                            if (boundAnnotationId === annotation.id) {
                              onBoundAnnotationChange(null);
                              onSelectionChange(null);
                            }
                        }}
                    >
                        <X size={10} className="text-white" />
                    </button>
                 </div>
             );
         })}

         {/* Creating annotation overlay (annotation tool mode) */}
         {renderCreatingOverlay()}

         {/* Selection region handles */}
         {renderSelectionHandles()}

         {/* Band-pass filter cutoff handles */}
         {renderFilterHandles()}
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
                  top: 16,
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
