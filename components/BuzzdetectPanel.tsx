import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Sliders, GripHorizontal } from 'lucide-react';
import { BuzzdetectData, Selection } from '../types';
import type { ViewportStore } from '../utils/viewportStore';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import {
  buzzdetectNeuronColor,
  DEFAULT_BUZZDETECT_THRESHOLD,
  MIN_BUZZDETECT_PANEL_HEIGHT,
  MAX_BUZZDETECT_PANEL_HEIGHT,
} from '../constants';
import { clamp } from '../utils/helpers';
import { timeToX, xToTime } from '../utils/viewportTransform';

// Match the spectrogram's 50px y-axis gutter so the drawing area starts at the
// same x and the two stay column-for-column aligned.
const Y_AXIS_WIDTH = 50;
const PAD_TOP = 12;
const PAD_BOTTOM = 12;

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
  // Persisted UI state.
  thresholds: Record<string, number>;
  hiddenNeurons: string[];
  height: number;
  // Callbacks.
  onThresholdChange: (neuron: string, value: number) => void;
  onToggleNeuron: (neuron: string, hidden: boolean) => void;
  onHeightChange: (height: number) => void;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onSeek: (time: number) => void;
  onScrollWheel?: (deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => void;
}

/** Controlled numeric input that lets the user type freely (incl. '-' and
 *  empty) and only commits a parsed value on blur or Enter. */
function ThresholdInput({ value, color, onCommit }: { value: number; color: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const v = parseFloat(draft);
    if (!isNaN(v)) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-right outline-none focus:border-[#e65161]"
      style={{ color }}
    />
  );
}

export default function BuzzdetectPanel({
  data,
  viewportStore,
  duration,
  currentTimeStore,
  selection,
  thresholds,
  hiddenNeurons,
  height,
  onThresholdChange,
  onToggleNeuron,
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
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);

  // Drag-to-select across bins. `dragging` gates the window listeners; the
  // anchor bin and latest interval live in refs so the listener effect attaches
  // once per drag rather than re-running as the selection updates.
  const [dragging, setDragging] = useState(false);
  const dragAnchorRef = useRef<number | null>(null);
  const dragSelRef = useRef<Selection | null>(null);

  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);

  // Per-neuron color is keyed by position in the model's output order so a
  // neuron keeps its color across files and toggles.
  const neuronColors = useMemo(
    () => (data ? data.neurons.map((_, i) => buzzdetectNeuronColor(i)) : []),
    [data],
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

  // Map a clientX to a bin index using the SHARED transform (scrollLeft / pps),
  // so a click lands on exactly the column the user sees under the cursor.
  const binAtClientX = useCallback((clientX: number): number | null => {
    if (!data || data.starts.length === 0) return null;
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const { scrollLeft, pixelsPerSecond } = viewportStore.get();
    const t = xToTime(clientX - rect.left, scrollLeft, pixelsPerSecond);
    const i = Math.floor((t - data.starts[0]) / data.binWidth);
    return clamp(i, 0, data.starts.length - 1);
  }, [data, viewportStore]);

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
    const iLeft = Math.max(0, Math.floor((startTime - starts[0]) / binWidth) - 1);
    const iRight = Math.min(starts.length - 1, Math.ceil((endTime - starts[0]) / binWidth) + 1);

    const enabled: number[] = [];
    for (let n = 0; n < neurons.length; n++) if (!hidden.has(neurons[n])) enabled.push(n);

    // Y-axis scale: use the file-wide activation range (pre-memoised so
    // scrolling/panning does NOT trigger a rescan). Thresholds are cheap and
    // may change without touching data, so fold them in at draw time instead.
    let yMin = fileWideRange ? fileWideRange.min : Infinity;
    let yMax = fileWideRange ? fileWideRange.max : -Infinity;
    for (const n of enabled) {
      const th = thresholdOf(neurons[n]);
      if (th < yMin) yMin = th;
      if (th > yMax) yMax = th;
    }
    if (!isFinite(yMin) || !isFinite(yMax)) { yMin = -2; yMax = 1; }
    if (yMax - yMin < 1e-6) { yMin -= 1; yMax += 1; }
    // 6% headroom so dots at the extremes aren't clipped.
    const padFrac = (yMax - yMin) * 0.06;
    yMin -= padFrac; yMax += padFrac;

    const usableH = h - PAD_TOP - PAD_BOTTOM;
    const yOf = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * usableH;

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

    // Hovered bin band — light feedback for the click target.
    if (hoverFrame !== null && hoverFrame >= iLeft && hoverFrame <= iRight) {
      const hx = xOf(starts[hoverFrame]);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(hx, 0, Math.max(1, binWidth * pixelsPerSecond), h);
    }

    // Soft vertical hash marks at frame boundaries (skip when bins get tight).
    const binPx = binWidth * pixelsPerSecond;
    if (binPx >= 6) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = iLeft; i <= iRight + 1; i++) {
        const x = xOf(starts[0] + i * binWidth);
        if (x < 0 || x > width) continue;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
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

    // Playhead.
    const px = xOf(currentTimeStore.get());
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }

    // Polylines + dots, one neuron at a time.
    const drawDots = binPx >= 4;
    for (const n of enabled) {
      const color = neuronColors[n];
      const th = thresholdOf(neurons[n]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = iLeft; i <= iRight; i++) {
        const cx = xOf(starts[i] + binWidth / 2);
        const cy = yOf(values[n][i]);
        if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
      }
      ctx.stroke();

      if (drawDots) {
        for (let i = iLeft; i <= iRight; i++) {
          const cx = xOf(starts[i] + binWidth / 2);
          if (cx < -4 || cx > width + 4) continue;
          const cy = yOf(values[n][i]);
          ctx.beginPath();
          ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
          if (values[n][i] >= th) {
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
  }, [data, fileWideRange, viewportStore, currentTimeStore, selection, hoverFrame, hidden, neuronColors, thresholdOf, areaSize]);

  // Coalesce redraws into a single rAF (matches the spectrogram's cadence).
  // `drawRef` always holds the latest `draw` so the viewport subscription (which
  // is set up once) calls the current closure without re-subscribing per render.
  const rafRef = useRef<number | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  // Redraw on prop-driven changes (data, currentTime, selection, settings…).
  useEffect(() => {
    scheduleDraw();
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw, scheduleDraw]);

  // Redraw on spectrogram pan/zoom/resize without any React render: the store
  // notifies, we read the new viewport at draw time. This is what keeps panning
  // smooth while the panel is open.
  useEffect(() => viewportStore.subscribe(scheduleDraw), [viewportStore, scheduleDraw]);
  // Redraw the playhead line as playback advances (time flows through the store,
  // not a prop), keeping it x-aligned with the spectrogram playhead.
  useEffect(() => currentTimeStore.subscribe(scheduleDraw), [currentTimeStore, scheduleDraw]);

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
  }, [dragging, binAtClientX, binInterval, onSelectionChange]);

  const handleAreaMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-buzz-ui]')) return;
    if (e.button !== 0) return;
    const i = binAtClientX(e.clientX);
    if (i === null) return;
    const interval = binInterval(i);
    dragAnchorRef.current = i;
    dragSelRef.current = interval;
    setDragging(true);
    onBoundAnnotationChange(null);
    onSelectionChange(interval);
    onSeek(interval.start);
  };

  const handleAreaMouseMove = (e: React.MouseEvent) => {
    if (dragging) return; // drag handled at window level
    setHoverFrame(binAtClientX(e.clientX));
  };

  // Drop a stale hovered frame when the track's data changes (indices differ).
  useEffect(() => { setHoverFrame(null); }, [data]);

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
          onMouseLeave={() => setHoverFrame(null)}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) e.preventDefault();
            onScrollWheel?.(e.deltaX, e.deltaY, e.ctrlKey, e.metaKey, e.clientX);
          }}
        >
          <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />

          {!data && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-slate-600 text-xs">No buzzdetect activations for this track</span>
            </div>
          )}

          {/* Hover readout — time + each enabled neuron's value, in color */}
          {data && hoverFrame !== null && (
            <div className="absolute top-1 left-2 pointer-events-none text-[10px] leading-tight font-mono bg-black/50 rounded px-1.5 py-1 max-w-[60%]">
              <div className="text-slate-300">t={data.starts[hoverFrame].toFixed(2)}s</div>
              <div className="flex flex-wrap gap-x-2">
                {data.neurons.map((n, i) => hidden.has(n) ? null : (
                  <span key={n} style={{ color: neuronColors[i] }}>
                    {n} {data.values[i][hoverFrame].toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Settings popover trigger */}
          <button
            data-buzz-ui
            onClick={() => setShowSettings(s => !s)}
            className={`absolute top-1.5 right-1.5 p-1 rounded transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white hover:bg-slate-700/70'}`}
            data-tooltip="buzzdetect settings"
          >
            <Sliders size={14} />
          </button>

          {showSettings && (
            <div
              data-buzz-ui
              className="absolute top-9 right-1.5 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-64 max-h-[calc(100%-2.5rem)] overflow-y-auto custom-scrollbar"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="p-3 space-y-2">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 pb-1 border-b border-slate-700">
                  <span>Neuron</span>
                  <span>Threshold</span>
                </div>
                {!data && <p className="text-slate-500 text-xs py-2">No data loaded.</p>}
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
                      <span className="w-3 h-3 rounded-sm flex-none" style={{ background: neuronColors[i] }} />
                      <span className="flex-1 text-xs text-slate-200 truncate" title={n}>{n}</span>
                      <ThresholdInput
                        value={thresholdOf(n)}
                        color={neuronColors[i]}
                        onCommit={(v) => onThresholdChange(n, v)}
                      />
                    </div>
                  );
                })}
                {data && enabledNeurons.length === 0 && (
                  <p className="text-slate-500 text-[11px] pt-1">All neurons hidden.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
