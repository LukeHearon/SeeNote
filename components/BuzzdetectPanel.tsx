import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { Sliders, GripHorizontal, RotateCcw } from 'lucide-react';
import { BuzzdetectData, Selection } from '../types';
import type { ViewportStore } from '../utils/viewportStore';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import {
  buzzdetectNeuronColor,
  BUZZDETECT_PALETTE,
  DEFAULT_BUZZDETECT_THRESHOLD,
  MIN_BUZZDETECT_PANEL_HEIGHT,
  MAX_BUZZDETECT_PANEL_HEIGHT,
} from '../constants';
import { clamp, formatTimeForUnit, TimeDisplayUnit } from '../utils/helpers';
import { timeToX, xToTime } from '../utils/viewportTransform';
import { binAtTime, visibleBinRange } from '../utils/binIndex';
import { buzzdetectPanel as buzzdetectCopy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import DraftNumberInput from './DraftNumberInput';
import ColorSwatchPicker from './ColorSwatchPicker';

// Match the spectrogram's 50px y-axis gutter so the drawing area starts at the
// same x and the two stay column-for-column aligned.
const Y_AXIS_WIDTH = 50;
const PAD_TOP = 12;
const PAD_BOTTOM = 12;
// Above this many visible bins, average them into groups to keep the drawn
// polyline near this point count instead of a scratchy per-bin path.
const MAX_LINE_POINTS = 1000;

interface BuzzdetectPanelProps {
  data: BuzzdetectData | null;
  // Shared viewport from the spectrogram (the single source of x-alignment).
  // Delivered through a ref-based store rather than props so panning, which
  // updates it every frame, never re-renders this component or its parent — the
  // panel reads the latest values at draw time and redraws its canvas directly.
  viewportStore: ViewportStore;
  duration: number;
  // Same store the spectrogram playhead reads, so the panel's playhead line
  // stays x-aligned with it. Subscribed below; read at draw time.
  currentTimeStore: CurrentTimeStore;
  selection: Selection | null;
  // Toolbar's running-time display unit — the hover readout's time(s) follow it.
  timeDisplayUnit: TimeDisplayUnit;
  // Persisted UI state.
  thresholds: Record<string, number>;
  hiddenNeurons: string[];
  // Per-neuron color override, keyed by neuron label. Absent entries fall
  // back to the palette-by-index default (buzzdetectNeuronColor).
  neuronColors: Record<string, string>;
  height: number;
  // Callbacks.
  onThresholdChange: (neuron: string, value: number) => void;
  onToggleNeuron: (neuron: string, hidden: boolean) => void;
  onNeuronColorChange: (neuron: string, color: string) => void;
  onHeightChange: (height: number) => void;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onSeek: (time: number) => void;
  onScrollWheel?: (deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => void;
}

export default function BuzzdetectPanel({
  data,
  viewportStore,
  duration,
  currentTimeStore,
  selection,
  timeDisplayUnit,
  thresholds,
  hiddenNeurons,
  neuronColors: neuronColorOverrides,
  height,
  onThresholdChange,
  onToggleNeuron,
  onNeuronColorChange,
  onHeightChange,
  onSelectionChange,
  onBoundAnnotationChange,
  onSeek,
  onScrollWheel,
}: BuzzdetectPanelProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const yAxisCanvasRef = useRef<HTMLCanvasElement>(null);
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const [showSettings, setShowSettings] = useState(false);
  // Hovered bin range (inclusive indices). A single bin when frames are
  // individually visible; the whole group of bins being averaged into one
  // polyline point when they're not (see groupSizeRef).
  const [hoverRange, setHoverRange] = useState<{ start: number; end: number } | null>(null);

  // Which neuron's color-swatch popover is open in the settings panel (null =
  // none). Closed on outside click below.
  const [openColorNeuron, setOpenColorNeuron] = useState<string | null>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openColorNeuron) return;
    const handler = (e: MouseEvent) => {
      if (colorPopoverRef.current && !colorPopoverRef.current.contains(e.target as Node)) {
        setOpenColorNeuron(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openColorNeuron]);

  // Drag-to-select across bins. `dragging` gates the window listeners; the
  // anchor bin and latest interval live in refs so the listener effect attaches
  // once per drag rather than re-running as the selection updates. When
  // individual frames aren't visible (see framesVisibleRef below), dragging
  // switches to raw time instead of bin snapping — dragAnchorTimeRef holds
  // that anchor and dragModeRef says which one is live.
  const [dragging, setDragging] = useState(false);
  const dragModeRef = useRef<'bin' | 'time'>('bin');
  const dragAnchorRef = useRef<number | null>(null);
  const dragAnchorTimeRef = useRef<number | null>(null);
  const dragSelRef = useRef<Selection | null>(null);

  // User-editable Y-axis range. Null means "use the auto-calculated file-wide
  // range" (fileWideRange, below); typing into either settings text box pins
  // it. Reset to null whenever a new file's data loads, so each file starts
  // from its own auto-calculated range rather than inheriting the last file's
  // manual override.
  const [yAxisOverride, setYAxisOverride] = useState<{ min: number; max: number } | null>(null);
  useEffect(() => { setYAxisOverride(null); }, [data]);

  // Whether individual frames currently read as distinguishable (dots +
  // boundary grid drawn) — set at draw time, read by the click/hover handlers
  // below to decide whether picking out a single frame is meaningful.
  const framesVisibleRef = useRef(true);
  // How many bins the polyline is currently averaging into one drawn point
  // (1 = no grouping) — set at draw time, read by the hover handler so its
  // readout covers the same span the line is actually averaging.
  const groupSizeRef = useRef(1);

  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);

  // Per-neuron color: the user's override (keyed by label, persisted across
  // files) if set, else the palette-by-index default — so a neuron keeps its
  // color across files and toggles even before it's ever been customized.
  const neuronColors = useMemo(
    () => (data ? data.neurons.map((n, i) => neuronColorOverrides[n] ?? buzzdetectNeuronColor(i)) : []),
    [data, neuronColorOverrides],
  );

  const thresholdOf = useCallback(
    (neuron: string) => thresholds[neuron] ?? DEFAULT_BUZZDETECT_THRESHOLD,
    [thresholds],
  );

  // Stable string key representing which neurons are currently enabled, in
  // index order. Recomputes only when `data` or `hidden` changes — not on scroll.
  const enabledKey = useMemo(() => {
    if (!data) return '';
    return data.neurons
      .map((n, i) => (hidden.has(n) ? '' : String(i)))
      .filter(s => s !== '')
      .join(',');
  }, [data, hidden]);

  // File-wide activation range across ALL bins for the currently enabled neurons.
  // Memoised so scrolling/panning never triggers a rescan of the full data arrays.
  const fileWideRange = useMemo<{ min: number; max: number } | null>(() => {
    if (!data || data.starts.length === 0) return null;
    const { neurons, values } = data;
    let lo = Infinity;
    let hi = -Infinity;
    for (let n = 0; n < neurons.length; n++) {
      if (hidden.has(neurons[n])) continue;
      const arr = values[n];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return { min: lo, max: hi };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, enabledKey]);

  // Map a clientX to a track time using the SHARED transform (scrollLeft /
  // pps), so a click lands on exactly the point the user sees under the
  // cursor. Used directly for time-based (frames-not-visible) selection, and
  // as the basis for binAtClientX below.
  const timeAtClientX = useCallback((clientX: number): number | null => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const { scrollLeft, pixelsPerSecond } = viewportStore.get();
    return xToTime(clientX - rect.left, scrollLeft, pixelsPerSecond);
  }, [viewportStore]);

  // Map a clientX to a bin index.
  const binAtClientX = useCallback((clientX: number): number | null => {
    if (!data || data.starts.length === 0) return null;
    const t = timeAtClientX(clientX);
    if (t === null) return null;
    // Null in the gaps between frames when binWidth is overridden shorter than
    // the frame spacing — there is genuinely no frame under the cursor there.
    return binAtTime(data.starts, data.binWidth, t);
  }, [data, timeAtClientX]);

  // The half-open interval [start, start+binWidth) for a bin, end clamped to EOF.
  const binInterval = useCallback((i: number): Selection => {
    const start = data!.starts[i];
    const end = duration > 0 ? Math.min(start + data!.binWidth, duration) : start + data!.binWidth;
    return { start, end };
  }, [data, duration]);

  // ── Drawing ────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = areaSize.width;
    const h = areaSize.height;
    if (width <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // Background.
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, h);

    if (!data || data.starts.length === 0) {
      ctx.restore();
      const yc = yAxisCanvasRef.current;
      const yx = yc?.getContext('2d');
      if (yc && yx) yx.clearRect(0, 0, yc.width, yc.height);
      return;
    }

    const { scrollLeft, pixelsPerSecond } = viewportStore.get();
    const { starts, binWidth, neurons, values } = data;
    const startTime = scrollLeft / pixelsPerSecond;
    const endTime = startTime + width / pixelsPerSecond;
    const xOf = (t: number) => timeToX(t, scrollLeft, pixelsPerSecond);

    // Visible bin index range (with a one-bin margin so partial edges connect).
    // Searched over `starts` rather than derived arithmetically: frames may be
    // non-contiguous when binWidth is overridden shorter than the frame spacing.
    const visible = visibleBinRange(starts, binWidth, startTime, endTime);
    if (!visible) { ctx.restore(); return; }
    const { iLeft, iRight } = visible;

    const enabled: number[] = [];
    for (let n = 0; n < neurons.length; n++) if (!hidden.has(neurons[n])) enabled.push(n);

    // Y-axis scale: the user's manual override if set, else the file-wide
    // activation range (pre-memoised so scrolling/panning does NOT trigger a
    // rescan). Thresholds are cheap and may change without touching data, so
    // fold them in at draw time instead.
    let yMin = yAxisOverride ? yAxisOverride.min : (fileWideRange ? fileWideRange.min : Infinity);
    let yMax = yAxisOverride ? yAxisOverride.max : (fileWideRange ? fileWideRange.max : -Infinity);
    // A manual override is meant to be respected exactly — as typed — so skip
    // the auto-mode widening (folding in out-of-range thresholds, headroom
    // padding) that would otherwise push the drawn extent past what the user
    // set.
    if (!yAxisOverride) {
      for (const n of enabled) {
        const th = thresholdOf(neurons[n]);
        if (th < yMin) yMin = th;
        if (th > yMax) yMax = th;
      }
    }
    if (!isFinite(yMin) || !isFinite(yMax)) { yMin = -2; yMax = 1; }
    if (yMax - yMin < 1e-6) { yMin -= 1; yMax += 1; }
    if (!yAxisOverride) {
      // 6% headroom so dots at the extremes aren't clipped.
      const padFrac = (yMax - yMin) * 0.06;
      yMin -= padFrac; yMax += padFrac;
    }

    const usableH = h - PAD_TOP - PAD_BOTTOM;
    const yOf = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * usableH;

    // Bin-grouping for the polyline (below) and for hover/click: above
    // MAX_LINE_POINTS visible bins, group them so the drawn line stays near
    // that point count instead of a scratchy per-bin path. Groups are
    // anchored to the absolute bin index (floor(i / groupSize)), not to
    // iLeft — otherwise a one-bin scroll shifts every bucket boundary and
    // re-partitions which bins get averaged together, so the "smoothed" line
    // (and the hover readout) would visibly writhe as you scrolled.
    const binPx = binWidth * pixelsPerSecond;
    const visibleCount = iRight - iLeft + 1;
    const groupSize = visibleCount > MAX_LINE_POINTS ? Math.ceil(visibleCount / MAX_LINE_POINTS) : 1;
    const drawDots = binPx >= 4 && groupSize === 1;
    // Same visibility gate the click/hover handlers use to decide whether a
    // single-frame selection is meaningful — individual frames read as
    // distinguishable only while their dots and boundary grid are drawn.
    framesVisibleRef.current = drawDots;
    groupSizeRef.current = groupSize;

    // Frame bands: a faint wash over the time each frame actually covers, so
    // uncovered time (frame length overridden shorter than the frame spacing)
    // reads as bare background rather than an implied contiguous grid.
    ctx.fillStyle = 'rgba(226, 232, 240, 0.045)';
    for (let i = iLeft; i <= iRight; i++) {
      const bx = xOf(starts[i]);
      const bw = binWidth * pixelsPerSecond;
      if (bx > width || bx + bw < 0) continue;
      ctx.fillRect(bx, 0, Math.max(1, bw), h);
    }

    // Selection highlight (mirrors the spectrogram's selected region).
    if (selection) {
      const sx = xOf(selection.start);
      const ex = xOf(selection.end);
      ctx.fillStyle = 'rgba(230, 81, 97, 0.14)';
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);
      ctx.strokeStyle = 'rgba(230, 81, 97, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      ctx.moveTo(ex, 0); ctx.lineTo(ex, h);
      ctx.stroke();
    }

    // Hovered bin (or bin-group) band — brighter than the resting frame wash
    // so the click target still reads clearly on top of it.
    if (hoverRange !== null && hoverRange.end >= iLeft && hoverRange.start <= iRight) {
      const hx = xOf(starts[hoverRange.start]);
      const hEndX = xOf(starts[hoverRange.end] + binWidth);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(hx, 0, Math.max(1, hEndX - hx), h);
    }

    // Darken frames where no enabled neuron cleared its threshold, so detected
    // frames pop by contrast against a dimmed background.
    if (enabled.length > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let i = iLeft; i <= iRight; i++) {
        const bx = xOf(starts[i]);
        const bw = binWidth * pixelsPerSecond;
        if (bx > width || bx + bw < 0) continue;
        let detected = false;
        for (const n of enabled) {
          if (values[n][i] >= thresholdOf(neurons[n])) { detected = true; break; }
        }
        if (!detected) ctx.fillRect(bx, 0, Math.max(1, bw), h);
      }
    }

    // Soft vertical hash marks at frame boundaries (skip when bins get tight).
    // Both edges of each frame are drawn from `starts`, so an overridden
    // binWidth reads as separated frames rather than a contiguous grid.
    if (binPx >= 6) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = iLeft; i <= iRight; i++) {
        for (const t of [starts[i], starts[i] + binWidth]) {
          const x = xOf(t);
          if (x < 0 || x > width) continue;
          ctx.moveTo(x, 0); ctx.lineTo(x, h);
        }
      }
      ctx.stroke();
    }

    // Per-neuron threshold lines (dashed, in the neuron's color).
    ctx.setLineDash([4, 4]);
    for (const n of enabled) {
      const y = yOf(thresholdOf(neurons[n]));
      ctx.strokeStyle = neuronColors[n] + '66';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Polylines + dots, one neuron at a time.
    for (const n of enabled) {
      const color = neuronColors[n];
      const th = thresholdOf(neurons[n]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      if (groupSize === 1) {
        for (let i = iLeft; i <= iRight; i++) {
          const cx = xOf(starts[i] + binWidth / 2);
          const cy = yOf(values[n][i]);
          if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
        }
      } else {
        const groupStart = Math.floor(iLeft / groupSize) * groupSize;
        const groupEndExclusive = Math.floor(iRight / groupSize) * groupSize + groupSize;
        for (let i = Math.max(groupStart, 0); i < groupEndExclusive; i += groupSize) {
          const end = Math.min(i + groupSize - 1, starts.length - 1);
          let sumT = 0, sumV = 0, count = 0;
          for (let j = i; j <= end; j++) {
            sumT += starts[j] + binWidth / 2;
            sumV += values[n][j];
            count++;
          }
          if (count === 0) continue;
          const cx = xOf(sumT / count);
          const cy = yOf(sumV / count);
          if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();

      if (drawDots) {
        for (let i = iLeft; i <= iRight; i++) {
          const cx = xOf(starts[i] + binWidth / 2);
          if (cx < -4 || cx > width + 4) continue;
          const cy = yOf(values[n][i]);
          const isPositive = values[n][i] >= th;
          ctx.beginPath();
          ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
          if (isPositive) {
            ctx.fillStyle = color;
            ctx.fill();
          } else {
            ctx.fillStyle = '#0b1220';
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }

    ctx.restore();

    // Y-axis labels in the gutter canvas.
    const yCanvas = yAxisCanvasRef.current;
    if (yCanvas) {
      const yctx = yCanvas.getContext('2d');
      if (yctx) {
        yctx.clearRect(0, 0, yCanvas.width, yCanvas.height);
        yctx.save();
        yctx.scale(dpr, dpr);
        yctx.fillStyle = 'rgba(11,18,32,0.85)';
        yctx.fillRect(0, 0, Y_AXIS_WIDTH, h);
        yctx.strokeStyle = 'rgba(255,255,255,0.15)';
        yctx.lineWidth = 1;
        yctx.beginPath();
        yctx.moveTo(Y_AXIS_WIDTH - 1, 0); yctx.lineTo(Y_AXIS_WIDTH - 1, h);
        yctx.stroke();
        yctx.fillStyle = 'rgba(255,255,255,0.7)';
        yctx.font = '10px sans-serif';
        yctx.textAlign = 'right';
        yctx.textBaseline = 'middle';
        const TICKS = 4;
        for (let k = 0; k <= TICKS; k++) {
          const v = yMin + (k / TICKS) * (yMax - yMin);
          const y = yOf(v);
          if (y < 8 || y > h - 6) continue;
          yctx.fillText(v.toFixed(1), Y_AXIS_WIDTH - 6, y);
        }
        yctx.restore();
      }
    }
  }, [data, fileWideRange, yAxisOverride, viewportStore, selection, hoverRange, hidden, neuronColors, thresholdOf, areaSize]);

  // Overlay canvas: just the playhead line, aligned to the same time→pixel
  // transform as the main canvas. Kept separate so playback ticks (~50/s)
  // repaint only this cheap line instead of the whole data-driven canvas above
  // (which was causing visible flicker/jank during playback).
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = areaSize.width;
    const h = areaSize.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (width <= 0 || h <= 0) return;
    ctx.save();
    ctx.scale(dpr, dpr);

    const { scrollLeft, pixelsPerSecond } = viewportStore.get();
    const px = timeToX(currentTimeStore.get(), scrollLeft, pixelsPerSecond);
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }
    ctx.restore();
  }, [viewportStore, currentTimeStore, areaSize]);

  // Self-scheduling rAF loop, split into two dirty flags — matches the
  // spectrogram's draw/overlay split: `drawDirty` covers the expensive
  // data-driven canvas (redrawn on data/viewport/selection/threshold changes),
  // `overlayDirty` covers only the playhead line (redrawn every playback tick).
  // Without the split, every ~50Hz currentTime tick was re-running the full
  // canvas — including the per-frame darken-overlay scan — which is what made
  // the playhead visibly janky during playback.
  const drawRef = useRef(draw);
  const drawDirtyRef = useRef(true);
  useLayoutEffect(() => {
    drawRef.current = draw;
    drawDirtyRef.current = true;
  }, [draw]);

  const drawOverlayRef = useRef(drawOverlay);
  const overlayDirtyRef = useRef(true);
  useLayoutEffect(() => {
    drawOverlayRef.current = drawOverlay;
    overlayDirtyRef.current = true;
  }, [drawOverlay]);

  // Redraw on spectrogram pan/zoom/resize without any React render: the store
  // notifies, we read the new viewport at draw time. This is what keeps panning
  // smooth while the panel is open. Panning shifts both the data canvas and the
  // playhead, so it marks both dirty.
  useEffect(() => viewportStore.subscribe(() => {
    drawDirtyRef.current = true;
    overlayDirtyRef.current = true;
  }), [viewportStore]);
  // Playback ticks only move the playhead line — no need to touch the data canvas.
  useEffect(() => currentTimeStore.subscribe(() => { overlayDirtyRef.current = true; }), [currentTimeStore]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      if (drawDirtyRef.current) { drawRef.current(); drawDirtyRef.current = false; }
      if (overlayDirtyRef.current) { drawOverlayRef.current(); overlayDirtyRef.current = false; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keep canvases sized to the drawing area.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.max(1, r.width);
      const hh = Math.max(1, r.height);
      setAreaSize({ width: w, height: hh });
      const dpr = window.devicePixelRatio || 1;
      if (canvasRef.current) {
        canvasRef.current.width = Math.round(w * dpr);
        canvasRef.current.height = Math.round(hh * dpr);
      }
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = Math.round(w * dpr);
        overlayCanvasRef.current.height = Math.round(hh * dpr);
      }
      if (yAxisCanvasRef.current) {
        yAxisCanvasRef.current.width = Math.round(Y_AXIS_WIDTH * dpr);
        yAxisCanvasRef.current.height = Math.round(hh * dpr);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Bin selection (click + drag across bins) ────────────────────────────────
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (dragModeRef.current === 'time') {
        const t = timeAtClientX(e.clientX);
        const anchor = dragAnchorTimeRef.current;
        if (t === null || anchor === null) return;
        const sel = { start: Math.min(anchor, t), end: Math.max(anchor, t) };
        dragSelRef.current = sel;
        onSelectionChange(sel);
        return;
      }
      const j = binAtClientX(e.clientX);
      const anchor = dragAnchorRef.current;
      if (j === null || anchor === null) return;
      const sel = { start: binInterval(Math.min(anchor, j)).start, end: binInterval(Math.max(anchor, j)).end };
      dragSelRef.current = sel;
      onSelectionChange(sel);
    };
    const onUp = () => {
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, binAtClientX, binInterval, timeAtClientX, onSelectionChange]);

  const handleAreaMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-buzz-ui]')) return;
    if (e.button !== 0) return;
    // At this zoom, dozens/hundreds of frames sit under one pixel column — a
    // click can't pick out a single one meaningfully. Still select and drag,
    // just anchored to raw time instead of a bin.
    if (!framesVisibleRef.current) {
      const t = timeAtClientX(e.clientX);
      if (t === null) return;

      if (e.shiftKey && selection) {
        const merged: Selection = {
          start: Math.min(selection.start, t),
          end: Math.max(selection.end, t),
        };
        dragSelRef.current = merged;
        onSelectionChange(merged);
        return;
      }

      dragModeRef.current = 'time';
      dragAnchorTimeRef.current = t;
      dragSelRef.current = { start: t, end: t };
      setDragging(true);
      onBoundAnnotationChange(null);
      onSelectionChange({ start: t, end: t });
      onSeek(t);
      return;
    }
    dragModeRef.current = 'bin';
    const i = binAtClientX(e.clientX);
    if (i === null) return;
    const interval = binInterval(i);

    // Shift+click extends the existing selection to also cover this frame,
    // merging the two ranges into one bounding interval. Using min/max of the
    // two ranges naturally handles overlapping bins — the union of two
    // overlapping intervals is just their combined min/max.
    if (e.shiftKey && selection) {
      const merged: Selection = {
        start: Math.min(selection.start, interval.start),
        end: Math.max(selection.end, interval.end),
      };
      dragSelRef.current = merged;
      onSelectionChange(merged);
      return;
    }

    dragAnchorRef.current = i;
    dragSelRef.current = interval;
    setDragging(true);
    onBoundAnnotationChange(null);
    onSelectionChange(interval);
    onSeek(interval.start);
  };

  const handleAreaMouseMove = (e: React.MouseEvent) => {
    if (dragging) return; // drag handled at window level
    const i = binAtClientX(e.clientX);
    if (i === null) { setHoverRange(null); return; }
    const groupSize = groupSizeRef.current;
    if (groupSize === 1) {
      setHoverRange({ start: i, end: i });
      return;
    }
    // Individual frames aren't distinguishable at this zoom (see
    // handleAreaMouseDown) — cover the whole group of bins the polyline is
    // averaging into the one point under the cursor, anchored the same way
    // the draw-time grouping is (absolute index, not iLeft-relative).
    const groupStart = Math.floor(i / groupSize) * groupSize;
    const groupEnd = Math.min(groupStart + groupSize - 1, data!.starts.length - 1);
    setHoverRange({ start: groupStart, end: groupEnd });
  };

  // Drop a stale hover range when the track's data changes (indices differ).
  useEffect(() => { setHoverRange(null); }, [data]);

  // ── Resize via top-edge handle ──────────────────────────────────────────────
  const handleResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const onMove = (ev: MouseEvent) => {
      // Drag up → taller.
      const next = clamp(startHeight + (startY - ev.clientY), MIN_BUZZDETECT_PANEL_HEIGHT, MAX_BUZZDETECT_PANEL_HEIGHT);
      onHeightChange(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const enabledNeurons = data ? data.neurons.filter(n => !hidden.has(n)) : [];

  return (
    <div className="flex-none bg-[#0b1220] border-t border-slate-700 flex flex-col relative" style={{ height }}>
      {/* Top-edge resize handle */}
      <div
        className="h-2 bg-slate-800 border-b border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors flex justify-center items-center flex-none"
        onMouseDown={handleResizeDown}
        data-buzz-ui
      >
        <GripHorizontal size={12} className="text-slate-600" />
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* Y-axis gutter, aligned to the spectrogram's 50px gutter */}
        <canvas ref={yAxisCanvasRef} className="h-full flex-shrink-0 pointer-events-none" style={{ width: Y_AXIS_WIDTH }} />

        {/* Drawing area — shares the spectrogram's time→pixel transform */}
        <div
          ref={areaRef}
          className="relative flex-1 h-full overflow-hidden"
          style={{ cursor: 'crosshair' }}
          onMouseDown={handleAreaMouseDown}
          onMouseMove={handleAreaMouseMove}
          onMouseLeave={() => setHoverRange(null)}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) e.preventDefault();
            onScrollWheel?.(e.deltaX, e.deltaY, e.ctrlKey, e.metaKey, e.clientX);
          }}
        >
          <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
          <canvas ref={overlayCanvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />

          {!data && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-slate-600 text-xs">{buzzdetectCopy.noActivations}</span>
            </div>
          )}

          {/* Hover readout — the hovered bin (or bin-group)'s time range and
              each enabled neuron's value (averaged across the group when
              more than one bin is covered), in color. */}
          {data && hoverRange !== null && (() => {
            const { start, end } = hoverRange;
            const isSingle = start === end;
            const rangeEnd = duration > 0 ? Math.min(data.starts[end] + data.binWidth, duration) : data.starts[end] + data.binWidth;
            return (
              <div className="absolute top-1 left-2 pointer-events-none text-[10px] leading-tight font-mono bg-black/50 rounded px-1.5 py-1 max-w-[60%]">
                <div className="text-slate-300">
                  {isSingle
                    ? `t=${formatTimeForUnit(data.starts[start], timeDisplayUnit)}`
                    : `t=${formatTimeForUnit(data.starts[start], timeDisplayUnit)}–${formatTimeForUnit(rangeEnd, timeDisplayUnit)}`}
                </div>
                <div className="flex flex-wrap gap-x-2">
                  {data.neurons.map((n, i) => {
                    if (hidden.has(n)) return null;
                    let value = data.values[i][start];
                    if (!isSingle) {
                      let sum = 0;
                      for (let j = start; j <= end; j++) sum += data.values[i][j];
                      value = sum / (end - start + 1);
                    }
                    return (
                      <span key={n} style={{ color: neuronColors[i] }}>
                        {n} {value.toFixed(2)}{!isSingle && ' avg'}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Settings popover trigger */}
          <button
            data-buzz-ui
            onClick={() => setShowSettings(s => !s)}
            className={`absolute top-1.5 right-1.5 p-1 rounded transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white hover:bg-slate-700/70'}`}
            data-tooltip={tooltips.buzzdetectSettings}
          >
            <Sliders size={14} />
          </button>

          {showSettings && (
            <div
              data-buzz-ui
              className="absolute top-9 right-1.5 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-64 max-h-[calc(100%-2.5rem)] overflow-y-auto custom-scrollbar"
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div className="p-3 space-y-2">
                {data && fileWideRange && (
                  <div className="pb-2 border-b border-slate-700 space-y-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400">
                      <span>{buzzdetectCopy.yAxisHeader}</span>
                      {yAxisOverride && (yAxisOverride.min !== fileWideRange.min || yAxisOverride.max !== fileWideRange.max) && (
                        <button
                          onClick={() => setYAxisOverride(null)}
                          className="text-slate-400 hover:text-[#e65161]"
                          data-tooltip={tooltips.buzzdetectYAxisReset}
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <DraftNumberInput
                        value={yAxisOverride?.min ?? fileWideRange.min}
                        onCommit={(v) => {
                          if (v === null) return;
                          setYAxisOverride({ min: v, max: yAxisOverride?.max ?? fileWideRange.max });
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 outline-none focus:border-[#e65161]"
                      />
                      <span className="text-slate-500 text-xs flex-none">–</span>
                      <DraftNumberInput
                        value={yAxisOverride?.max ?? fileWideRange.max}
                        onCommit={(v) => {
                          if (v === null) return;
                          setYAxisOverride({ min: yAxisOverride?.min ?? fileWideRange.min, max: v });
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 outline-none focus:border-[#e65161]"
                      />
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 pb-1 border-b border-slate-700">
                  <span>{buzzdetectCopy.neuronHeader}</span>
                  <span>{buzzdetectCopy.thresholdHeader}</span>
                </div>
                {!data && <p className="text-slate-500 text-xs py-2">{buzzdetectCopy.noDataLoaded}</p>}
                {data && data.neurons.map((n, i) => {
                  const isOn = !hidden.has(n);
                  return (
                    <div key={n} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => onToggleNeuron(n, isOn)}
                        className="accent-[#e65161] flex-none"
                      />
                      <div className="relative flex-none">
                        <button
                          onClick={() => setOpenColorNeuron(v => v === n ? null : n)}
                          className="block w-3 h-3 rounded-sm ring-1 ring-white/20"
                          style={{ background: neuronColors[i] }}
                          data-tooltip={tooltips.buzzdetectNeuronColor}
                        />
                        {openColorNeuron === n && (
                          <div
                            ref={colorPopoverRef}
                            className="absolute left-0 top-full mt-1.5 z-30 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-2 w-40"
                          >
                            <ColorSwatchPicker
                              value={neuronColors[i]}
                              swatchColors={BUZZDETECT_PALETTE}
                              onChange={(c) => onNeuronColorChange(n, c)}
                              customColorTitle={buzzdetectCopy.customColorTitle}
                              size={14}
                              popoverPosition="bottom"
                            />
                          </div>
                        )}
                      </div>
                      <span className="flex-1 text-xs text-slate-200 truncate" title={n}>{n}</span>
                      <DraftNumberInput
                        value={thresholdOf(n)}
                        onCommit={(v) => onThresholdChange(n, v)}
                        className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-right outline-none focus:border-[#e65161]"
                        style={{ color: neuronColors[i] }}
                      />
                    </div>
                  );
                })}
                {data && enabledNeurons.length === 0 && (
                  <p className="text-slate-500 text-[11px] pt-1">{buzzdetectCopy.allNeuronsHidden}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
