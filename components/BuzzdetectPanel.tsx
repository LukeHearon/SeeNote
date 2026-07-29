import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { Sliders, GripHorizontal, RotateCcw } from 'lucide-react';
import { BuzzdetectData, BuzzdetectSeriesMode, Selection } from '../types';
import type { ViewportStore } from '../utils/viewportStore';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import {
  buzzdetectNeuronColor,
  BUZZDETECT_PALETTE,
  DEFAULT_BUZZDETECT_THRESHOLD,
  MIN_BUZZDETECT_PANEL_HEIGHT,
  MAX_BUZZDETECT_PANEL_HEIGHT,
  Y_AXIS_WIDTH,
} from '../constants';
import { clamp, formatTimeForUnit, TimeDisplayUnit } from '../utils/helpers';
import { timeToX, xToTime } from '../utils/viewportTransform';
import { binAtTime, bucketFrameRange, frameRangeForTimeSpan, visibleBinRange } from '../utils/binIndex';
import {
  buildPrefixSum,
  buildThresholdCountPrefix,
  buildAnyOverThresholdPrefix,
  rangeSum,
  rangeMean,
} from '../utils/prefixSums';
import { coalesceColumnRuns } from '../utils/columnRuns';
import { shouldPromoteDragIntent } from '../utils/dragIntent';
import { buzzdetectPanel as buzzdetectCopy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import DraftNumberInput from './DraftNumberInput';
import ColorSwatchPicker from './ColorSwatchPicker';

const PAD_TOP = 12;
const PAD_BOTTOM = 12;
// Above this many visible bins, average them into groups to keep the drawn
// polyline near this point count instead of a scratchy per-bin path.
const MAX_LINE_POINTS = 1000;
// Auto Y-range for detection-rate mode: it's a fraction of the frames in a bin
// clearing the threshold, so always 0..1 — no data scan needed.
const DETECTION_RATE_Y_RANGE = { min: 0, max: 1 };

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
  // Which series the panel plots.
  seriesMode: BuzzdetectSeriesMode;
  // User-pinned bin width (seconds); null = auto-calculated. Persisted, and
  // deliberately NOT reset when the track changes — only when seriesMode
  // flips (the two modes' natural auto bin widths aren't comparable).
  binWidthOverride: number | null;
  height: number;
  // Callbacks.
  onThresholdChange: (neuron: string, value: number) => void;
  onToggleNeuron: (neuron: string, hidden: boolean) => void;
  onNeuronColorChange: (neuron: string, color: string) => void;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
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
  seriesMode,
  binWidthOverride,
  height,
  onThresholdChange,
  onToggleNeuron,
  onNeuronColorChange,
  onSeriesModeChange,
  onBinWidthOverrideChange,
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
  // individually visible; the whole time-bucket being aggregated into one
  // polyline point when they're not (see framesVisibleRef/effectiveBinWidthRef).
  // Lives in a ref as well as state: the ref is what the overlay canvas paints
  // from (so a mousemove costs one cheap overlay repaint, not a React render
  // plus a full data-canvas redraw), and the state exists only to drive the DOM
  // readout — updated through `setHover` below, which drops no-op moves.
  const hoverRangeRef = useRef<{ start: number; end: number } | null>(null);
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

  // Drag-intent guard, shared with the spectrogram (see
  // utils/dragIntent.ts): a mousedown doesn't create a selection
  // outright, only a "pending" intent. It's promoted to a real drag-selection
  // once the pointer moves far enough or is held long enough — otherwise a
  // very short click leaves no selection behind, just the seek.
  const pendingRef = useRef<
    | { mode: 'bin'; anchorBin: number; startX: number; startTime: number }
    | { mode: 'time'; anchorTime: number; startX: number; startTime: number }
    | null
  >(null);
  // Discard any pending (never-promoted) click intent on release, wherever it
  // happens — this is what makes a short click leave no selection.
  useEffect(() => {
    const onWindowMouseUp = () => { pendingRef.current = null; };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => window.removeEventListener('mouseup', onWindowMouseUp);
  }, []);

  // User-editable Y-axis range. Null means "use the auto-calculated range"
  // (activeAutoYRange, below); typing into either settings text box pins it.
  // Reset whenever a new file's data loads, so each file starts from its own
  // auto-calculated range rather than inheriting a stale manual override.
  const [yAxisOverride, setYAxisOverride] = useState<{ min: number; max: number } | null>(null);
  useEffect(() => { setYAxisOverride(null); }, [data]);

  // binWidthOverride is a persisted prop (deliberately NOT reset per track —
  // see its prop doc), but a series-mode flip still needs to reset both it
  // and the Y-axis override, since the two modes plot in entirely different
  // units and their auto-calculated ranges/widths aren't comparable. Skips
  // the reset on mount so loading a project with a persisted override doesn't
  // immediately wipe it.
  const seriesModeMountedRef = useRef(false);
  useEffect(() => {
    if (!seriesModeMountedRef.current) { seriesModeMountedRef.current = true; return; }
    setYAxisOverride(null);
    onBinWidthOverrideChange(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesMode]);

  // Live-updated (only while the settings popover is open, to avoid
  // re-rendering every draw tick for no visible benefit) auto-calculated bin
  // width, so the settings text box shows "the current auto-binning
  // binwidth" per the spec, even as it changes with zoom.
  const [autoBinWidthDisplay, setAutoBinWidthDisplay] = useState(0);

  // Whether individual frames currently read as distinguishable (dots drawn,
  // one polyline point per native frame) — set at draw time, read by BOTH the
  // mousedown and the hover handler, which must agree: whatever a drag would
  // select is what the readout has to describe.
  const framesVisibleRef = useRef(true);
  // The bin width (seconds) currently in effect — auto or overridden — set at
  // draw time, read by the hover handler to compute which time-bucket the
  // cursor falls into.
  const effectiveBinWidthRef = useRef(0);

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

  // Indices of the currently enabled neurons, in index order.
  const enabled = useMemo(() => {
    if (!data) return [];
    const out: number[] = [];
    for (let n = 0; n < data.neurons.length; n++) if (!hidden.has(data.neurons[n])) out.push(n);
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, enabledKey]);

  // Stable string key over the thresholds actually in play, so the
  // threshold-dependent prefix sums below rebuild on a threshold edit (a rare
  // user action) but not on every render that happens to pass a new
  // `thresholds` object identity.
  const thresholdKey = useMemo(
    () => (data ? data.neurons.map(n => thresholdOf(n)).join(',') : ''),
    [data, thresholdOf],
  );

  // Prefix sums over the per-frame series (see utils/prefixSums.ts). These turn
  // every range aggregate the panel needs — a polyline bucket's mean, the
  // selection readout's average, the darken pass's "any detection in this pixel
  // column" — from an O(range) scan into a subtraction. Built once per data /
  // threshold / enabled-set change rather than per redraw.
  const activationPrefix = useMemo(
    () => (data ? data.values.map(v => buildPrefixSum(v)) : null),
    [data],
  );
  const detectionPrefix = useMemo(
    () => (data ? data.values.map((v, i) => buildThresholdCountPrefix(v, thresholdOf(data.neurons[i]))) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, thresholdKey],
  );
  // Per-frame OR across the enabled neurons — an OR isn't a sum, so it can't be
  // recovered from the per-neuron counts above and needs its own prefix.
  const anyDetectedPrefix = useMemo(
    () => (data
      ? buildAnyOverThresholdPrefix(
          enabled.map(n => ({ values: data.values[n], threshold: thresholdOf(data.neurons[n]) })),
          data.starts.length,
        )
      : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, thresholdKey, enabled],
  );

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

  const fileWideDetectionRateRange = data ? DETECTION_RATE_Y_RANGE : null;

  // Whichever range applies to the current series mode — the base (pre
  // override, pre-threshold-widening) auto Y-range.
  const activeAutoYRange = seriesMode === 'activation' ? fileWideRange : fileWideDetectionRateRange;

  // Bin range covered by the current selection (inclusive indices), for the
  // persistent selection readout below. Half-open on the right, so selecting
  // exactly one frame reads as one frame rather than spilling into its
  // neighbour.
  const selectionBinRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!selection || !data) return null;
    return frameRangeForTimeSpan(data.starts, data.binWidth, selection.start, selection.end);
  }, [data, selection]);

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

    // Tick labels describe an axis that isn't being drawn, so any early return
    // below has to wipe the gutter too — otherwise scrolling past the last
    // frame leaves stale numbers next to an empty panel.
    const clearYAxis = () => {
      const yc = yAxisCanvasRef.current;
      const yx = yc?.getContext('2d');
      if (yc && yx) yx.clearRect(0, 0, yc.width, yc.height);
    };

    if (!data || data.starts.length === 0) {
      ctx.restore();
      clearYAxis();
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
    if (!visible) { ctx.restore(); clearYAxis(); return; }
    const { iLeft, iRight } = visible;

    // Bin width (seconds) for the polyline (below) and for hover/click: above
    // MAX_LINE_POINTS visible bins, an auto width groups them so the drawn
    // line stays near that point count instead of a scratchy per-bin path;
    // the user's override, if set, replaces that auto width outright. Bucket
    // boundaries are anchored to absolute time (floor(t / binWidthSec)), not
    // to iLeft — otherwise a one-bin scroll shifts every bucket boundary and
    // re-partitions which frames get grouped together, so the "smoothed"
    // line (and the hover readout) would visibly writhe as you scrolled.
    const binPx = binWidth * pixelsPerSecond;
    const visibleCount = iRight - iLeft + 1;
    const autoBinWidthSec = visibleCount > MAX_LINE_POINTS ? (endTime - startTime) / MAX_LINE_POINTS : binWidth;
    const effectiveBinWidthSec = Math.max(binWidthOverride ?? autoBinWidthSec, binWidth);
    const grouped = effectiveBinWidthSec > binWidth * 1.0001;
    const drawDots = binPx >= 4 && !grouped;
    // Same visibility gate the click/hover handlers use to decide whether a
    // single-frame selection is meaningful — individual frames read as
    // distinguishable only while their dots and boundary grid are drawn.
    framesVisibleRef.current = drawDots;
    effectiveBinWidthRef.current = effectiveBinWidthSec;
    if (showSettings) {
      setAutoBinWidthDisplay(Math.round(autoBinWidthSec * 10000) / 10000);
    }

    // With individual frames visible, detection rate is a binary per-frame
    // outcome (each dot is 0 or 1) — not a rate at all — so the axis should
    // read "Detection"/"No Detection" rather than 0%/100%, and the user's Y
    // limits (meant for a continuous scale) don't apply.
    const binaryDetection = seriesMode === 'detectionRate' && drawDots;

    // Y-axis scale: the user's manual override if set, else the mode's
    // auto-calculated range (pre-memoised so scrolling/panning does NOT
    // trigger a rescan). Thresholds are cheap and may change without
    // touching data, so fold them in at draw time instead — and only in
    // activation mode, where they're a value on this axis; a detection rate
    // isn't measured in the same units as the logit threshold that produces it.
    let yMin = yAxisOverride ? yAxisOverride.min : (activeAutoYRange ? activeAutoYRange.min : Infinity);
    let yMax = yAxisOverride ? yAxisOverride.max : (activeAutoYRange ? activeAutoYRange.max : -Infinity);
    // A manual override is meant to be respected exactly — as typed — so skip
    // the auto-mode widening (folding in out-of-range thresholds, headroom
    // padding) that would otherwise push the drawn extent past what the user
    // set.
    if (!yAxisOverride && seriesMode === 'activation') {
      // Always keep the zero baseline in view in auto mode, even if every
      // activation value (and threshold) happens to be positive.
      if (isFinite(yMin)) yMin = Math.min(yMin, 0);
      for (const n of enabled) {
        const th = thresholdOf(neurons[n]);
        if (th < yMin) yMin = th;
        if (th > yMax) yMax = th;
      }
    }
    if (!isFinite(yMin) || !isFinite(yMax)) { yMin = -2; yMax = 1; }
    // A min typed above the max would otherwise plot silently upside-down.
    if (yMax < yMin) { const t = yMin; yMin = yMax; yMax = t; }
    if (yMax - yMin < 1e-6) { yMin -= 1; yMax += 1; }
    if (binaryDetection) {
      yMin = 0; yMax = 1;
    } else if (!yAxisOverride) {
      if (seriesMode === 'activation') {
        // 6% headroom so dots at the extremes aren't clipped.
        const padFrac = (yMax - yMin) * 0.06;
        yMin -= padFrac; yMax += padFrac;
      } else {
        // Detection rate is a fraction — 0%/100% are real, meaningful bounds,
        // not values needing headroom to avoid clipping (unlike arbitrary
        // activation values), so the axis shouldn't read past them.
        yMin = 0; yMax = 1;
      }
    }

    const usableH = h - PAD_TOP - PAD_BOTTOM;
    const yOf = (v: number) => PAD_TOP + (1 - (v - yMin) / (yMax - yMin)) * usableH;

    // Below one pixel per frame, the two full-height wash passes below would
    // issue a rect per visible frame — tens of thousands of them on a long
    // recording, hundreds of which land in the same pixel column. Resolve each
    // column's frames once instead, and let the passes paint at most one merged
    // rect per column (see utils/columnRuns.ts). At or above a pixel per frame
    // the original per-frame rects are kept, so that path is unchanged.
    const subPixelFrames = binPx < 1;
    const columnFrames: ({ start: number; end: number } | null)[] = [];
    if (subPixelFrames) {
      const cols = Math.ceil(width);
      for (let c = 0; c < cols; c++) {
        columnFrames.push(frameRangeForTimeSpan(
          starts,
          binWidth,
          xToTime(c, scrollLeft, pixelsPerSecond),
          xToTime(c + 1, scrollLeft, pixelsPerSecond),
        ));
      }
    }

    // Frame bands: a faint wash over the time each frame actually covers, so
    // uncovered time (frame length overridden shorter than the frame spacing)
    // reads as bare background rather than an implied contiguous grid.
    ctx.fillStyle = 'rgba(226, 232, 240, 0.045)';
    if (subPixelFrames) {
      for (const run of coalesceColumnRuns(width, c => columnFrames[c] !== null)) {
        ctx.fillRect(run.x, 0, run.w, h);
      }
    } else {
      for (let i = iLeft; i <= iRight; i++) {
        const bx = xOf(starts[i]);
        if (bx > width || bx + binPx < 0) continue;
        ctx.fillRect(bx, 0, Math.max(1, binPx), h);
      }
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

    // (The hovered bin/bin-group band lives on the overlay canvas — see
    // drawOverlay — so moving the cursor doesn't repaint this canvas.)

    // Darken frames where no enabled neuron cleared its threshold, so detected
    // frames pop by contrast against a dimmed background. The per-frame "any
    // enabled neuron over threshold" test is a prefix-sum lookup rather than a
    // scan across neurons.
    if (enabled.length > 0 && anyDetectedPrefix) {
      const undetectedIn = (r: { start: number; end: number }) =>
        rangeSum(anyDetectedPrefix, r.start, r.end) < r.end - r.start + 1;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      if (subPixelFrames) {
        for (const run of coalesceColumnRuns(width, c => {
          const r = columnFrames[c];
          return r !== null && undetectedIn(r);
        })) {
          ctx.fillRect(run.x, 0, run.w, h);
        }
      } else {
        for (let i = iLeft; i <= iRight; i++) {
          const bx = xOf(starts[i]);
          if (bx > width || bx + binPx < 0) continue;
          if (undetectedIn({ start: i, end: i })) ctx.fillRect(bx, 0, Math.max(1, binPx), h);
        }
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

    // Per-neuron threshold lines (dashed, in the neuron's color) — only in
    // activation mode; a detection rate isn't in the threshold's units.
    if (seriesMode === 'activation') {
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
    }

    // Bucket partition for the grouped polyline, computed once for all neurons
    // (they all average over the same frames). Bucket range comes from the
    // VIEWPORT, not from iLeft/iRight: buckets are anchored to absolute time,
    // so the bucket containing the left edge can begin long before the first
    // visible frame, and with a wide override the whole viewport can sit inside
    // a single bucket — deriving the range from visible frames then yields one
    // point. One bucket of margin each side so the polyline connects off-screen.
    // Frames are taken from the whole bucket span, not clipped to the visible
    // range, so edge buckets average over all their frames and don't shift
    // value as you scroll.
    const buckets: { start: number; end: number; xMid: number; xStart: number; xEnd: number }[] = [];
    if (grouped) {
      const firstBucket = Math.floor(startTime / effectiveBinWidthSec) - 1;
      const lastBucket = Math.floor(endTime / effectiveBinWidthSec) + 1;
      for (let b = firstBucket; b <= lastBucket; b++) {
        const r = bucketFrameRange(starts, effectiveBinWidthSec, b);
        if (!r) continue;
        const bStart = b * effectiveBinWidthSec;
        buckets.push({
          ...r,
          xMid: xOf(bStart + effectiveBinWidthSec / 2),
          xStart: xOf(bStart),
          xEnd: xOf(bStart + effectiveBinWidthSec),
        });
      }
    }

    // Polylines + dots, one neuron at a time. In activation mode each point
    // is the mean activation over its bucket; in detection-rate mode it's
    // the fraction of the bucket's frames clearing the threshold (both are
    // just "average the per-frame value", differing only in what that
    // per-frame value is).
    for (const n of enabled) {
      const color = neuronColors[n];
      const th = thresholdOf(neurons[n]);
      const perFrameValue = (i: number) => seriesMode === 'activation' ? values[n][i] : (values[n][i] >= th ? 1 : 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      if (!grouped) {
        for (let i = iLeft; i <= iRight; i++) {
          const cx = xOf(starts[i] + binWidth / 2);
          const cy = yOf(perFrameValue(i));
          if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
        }
      } else {
        // Prefix-sum lookup, not a scan: a bucket can span hours of frames
        // when the user pins a wide bin width, and the buckets are recomputed
        // on every redraw (they're time-anchored, so they're stable, but the
        // draw path doesn't cache them).
        const prefix = seriesMode === 'activation' ? activationPrefix?.[n] : detectionPrefix?.[n];
        const bucketMean = (bk: { start: number; end: number }) => (
          prefix ? rangeMean(prefix, bk.start, bk.end) : 0
        );
        if (buckets.length === 1) {
          // Every frame in view falls in one bucket (a wide override on a short
          // file): a lone moveTo strokes nothing and grouped mode draws no dots,
          // so the neuron would vanish. Stroke the bucket's value flat across
          // its own x-extent instead.
          const cy = yOf(bucketMean(buckets[0]));
          ctx.moveTo(buckets[0].xStart, cy);
          ctx.lineTo(buckets[0].xEnd, cy);
        } else {
          for (const bk of buckets) {
            const cy = yOf(bucketMean(bk));
            if (!started) { ctx.moveTo(bk.xMid, cy); started = true; } else ctx.lineTo(bk.xMid, cy);
          }
        }
      }
      ctx.stroke();

      if (drawDots) {
        for (let i = iLeft; i <= iRight; i++) {
          const cx = xOf(starts[i] + binWidth / 2);
          if (cx < -4 || cx > width + 4) continue;
          const isPositive = values[n][i] >= th;
          const cy = yOf(perFrameValue(i));
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
        if (binaryDetection) {
          const yTop = yOf(1);
          if (yTop >= 8 && yTop <= h - 6) yctx.fillText(buzzdetectCopy.detection, Y_AXIS_WIDTH - 6, yTop, Y_AXIS_WIDTH - 8);
        } else {
          const TICKS = 4;
          for (let k = 0; k <= TICKS; k++) {
            const v = yMin + (k / TICKS) * (yMax - yMin);
            const y = yOf(v);
            if (y < 8 || y > h - 6) continue;
            yctx.fillText(seriesMode === 'activation' ? v.toFixed(1) : `${(v * 100).toFixed(0)}%`, Y_AXIS_WIDTH - 6, y);
          }
        }
        yctx.restore();
      }
    }
  }, [data, activeAutoYRange, yAxisOverride, binWidthOverride, seriesMode, showSettings, viewportStore, selection, enabled, activationPrefix, detectionPrefix, anyDetectedPrefix, neuronColors, thresholdOf, areaSize]);

  // Overlay canvas: the playhead line and the hover band, aligned to the same
  // time→pixel transform as the main canvas. Kept separate so playback ticks
  // (~50/s) and mouse moves repaint only these cheap shapes instead of the
  // whole data-driven canvas above (which was causing visible flicker/jank
  // during playback, and made merely moving the cursor cost as much as a pan).
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

    // Hovered bin (or bin-group) band — brighter than the resting frame wash
    // so the click target still reads clearly on top of it. Read from a ref
    // rather than state so a mousemove never re-renders the component or
    // dirties the main canvas.
    const hr = hoverRangeRef.current;
    if (data && hr && hr.start >= 0 && hr.end < data.starts.length) {
      const hx = timeToX(data.starts[hr.start], scrollLeft, pixelsPerSecond);
      const hEndX = timeToX(data.starts[hr.end] + data.binWidth, scrollLeft, pixelsPerSecond);
      if (hEndX >= 0 && hx <= width) {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(hx, 0, Math.max(1, hEndX - hx), h);
      }
    }

    const px = timeToX(currentTimeStore.get(), scrollLeft, pixelsPerSecond);
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
      ctx.stroke();
    }
    ctx.restore();
  }, [data, viewportStore, currentTimeStore, areaSize]);

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

  // Single entry point for hover changes: repaint the overlay, and update the
  // readout's state only when the range actually moved (compared by value —
  // every mousemove produces a fresh object, so identity would never match and
  // React would never bail out of the render).
  const setHover = useCallback((r: { start: number; end: number } | null) => {
    const prev = hoverRangeRef.current;
    if (prev === r) return;
    if (prev && r && prev.start === r.start && prev.end === r.end) return;
    hoverRangeRef.current = r;
    overlayDirtyRef.current = true;
    setHoverRange(r);
  }, []);

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
        onSelectionChange(sel);
        return;
      }
      const j = binAtClientX(e.clientX);
      const anchor = dragAnchorRef.current;
      if (j === null || anchor === null) return;
      const sel = { start: binInterval(Math.min(anchor, j)).start, end: binInterval(Math.max(anchor, j)).end };
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

  // Promotes a pending click intent into a real drag-selection once the
  // pointer has moved far enough or been held long enough (checked by the
  // caller). `clientX` is the triggering move's position, so the initial
  // drag-selection reflects it immediately rather than waiting a tick.
  const promotePending = useCallback((clientX: number) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    dragModeRef.current = pending.mode;
    onBoundAnnotationChange(null);
    if (pending.mode === 'time') {
      dragAnchorTimeRef.current = pending.anchorTime;
      const t = timeAtClientX(clientX) ?? pending.anchorTime;
      const sel = { start: Math.min(pending.anchorTime, t), end: Math.max(pending.anchorTime, t) };
      onSelectionChange(sel);
    } else {
      dragAnchorRef.current = pending.anchorBin;
      const j = binAtClientX(clientX);
      const sel = j === null
        ? binInterval(pending.anchorBin)
        : { start: binInterval(Math.min(pending.anchorBin, j)).start, end: binInterval(Math.max(pending.anchorBin, j)).end };
      onSelectionChange(sel);
    }
    setDragging(true);
  }, [onBoundAnnotationChange, onSelectionChange, timeAtClientX, binAtClientX, binInterval]);

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
        onSelectionChange(merged);
        return;
      }

      onSeek(t);
      // Same drag-intent guard as the spectrogram (shouldPromoteDragIntent): don't
      // commit to a selection yet — a very short click should leave the seek
      // as its only effect. Clicking outside the current selection clears it
      // immediately (matching the spectrogram), same as a real click would;
      // clicking inside it is left alone in case this turns out to be a plain
      // seek-and-release.
      if (!selection || t < selection.start || t > selection.end) {
        onBoundAnnotationChange(null);
        onSelectionChange(null);
      }
      pendingRef.current = { mode: 'time', anchorTime: t, startX: e.clientX, startTime: Date.now() };
      return;
    }
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
      onSelectionChange(merged);
      return;
    }

    onSeek(interval.start);
    if (!selection || interval.start < selection.start || interval.start > selection.end) {
      onBoundAnnotationChange(null);
      onSelectionChange(null);
    }
    pendingRef.current = { mode: 'bin', anchorBin: i, startX: e.clientX, startTime: Date.now() };
  };

  const handleAreaMouseMove = (e: React.MouseEvent) => {
    const pending = pendingRef.current;
    if (pending) {
      const promote = shouldPromoteDragIntent({
        containerWidth: areaRef.current?.clientWidth || 0,
        startX: pending.startX,
        currentX: e.clientX,
        startTime: pending.startTime,
        now: Date.now(),
      });
      if (promote) promotePending(e.clientX);
      return;
    }
    if (dragging) return; // drag handled at window level
    if (framesVisibleRef.current) {
      const i = binAtClientX(e.clientX);
      setHover(i === null ? null : { start: i, end: i });
      return;
    }
    // Individual frames aren't distinguishable at this zoom, so mousedown drags
    // a free time range (see handleAreaMouseDown) — the readout has to match, so
    // cover the whole time-bucket the polyline aggregates into the one point
    // under the cursor, anchored the same way the draw-time bucketing is
    // (absolute time, not iLeft-relative).
    const t = timeAtClientX(e.clientX);
    if (t === null || !data) { setHover(null); return; }
    const bucketWidth = effectiveBinWidthRef.current;
    if (!(bucketWidth > 0)) { setHover(null); return; }
    // Same partition function the draw loop buckets with, so the readout can't
    // disagree with the point under the cursor.
    setHover(bucketFrameRange(data.starts, bucketWidth, Math.floor(t / bucketWidth)));
  };

  // Drop a stale hover range when the track's data changes (indices differ).
  useEffect(() => { setHover(null); }, [data, setHover]);

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

  // Renders the small top-left readout for a bin range: its time span, and each
  // enabled neuron's value. One call site — it shows the selection's range when
  // there is a selection, else the hovered bin (or bin-group).
  //
  // In activation mode: the raw value for a single frame, averaged across
  // the range otherwise. In detection-rate mode: just Detection/No Detection
  // for a single frame (a rate over one frame isn't meaningful — it's the
  // frame's own dot, drawn at 1 or 0), else the fraction of the range's
  // frames clearing the threshold.
  const renderBinRangeReadout = (range: { start: number; end: number }) => {
    if (!data) return null;
    const { start, end } = range;
    // A hover range from the previous track outlives the render that swapped
    // `data` in (it's only cleared in an effect), so bail on out-of-range
    // indices here rather than reading past the new arrays.
    if (start < 0 || end < start || end >= data.starts.length) return null;
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
            if (seriesMode === 'detectionRate') {
              const th = thresholdOf(n);
              if (isSingle) {
                const detected = data.values[i][start] >= th;
                return (
                  <span key={n} style={{ color: neuronColors[i] }}>
                    {n} {detected ? buzzdetectCopy.detection : buzzdetectCopy.noDetection}
                  </span>
                );
              }
              // Prefix-sum lookup: the selection readout is persistent and
              // re-renders freely, and a selection can span the whole file.
              const rate = detectionPrefix ? rangeMean(detectionPrefix[i], start, end) : 0;
              return (
                <span key={n} style={{ color: neuronColors[i] }}>
                  {n} {(rate * 100).toFixed(0)}%
                </span>
              );
            }
            const value = isSingle
              ? data.values[i][start]
              : (activationPrefix ? rangeMean(activationPrefix[i], start, end) : 0);
            return (
              <span key={n} style={{ color: neuronColors[i] }}>
                {n} {value.toFixed(2)}{!isSingle && ' avg'}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

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
          onMouseLeave={() => setHover(null)}
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

          {/* Readout — time range + each enabled neuron's value, in color.
              The current selection takes priority and stays put regardless
              of the cursor once one exists (so it can't be "stomped" by
              moving the mouse over the panel); only without a selection does
              it track the hovered bin (or bin-group). */}
          {data && (selectionBinRange ?? hoverRange) !== null &&
            renderBinRangeReadout((selectionBinRange ?? hoverRange)!)}

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
                {data && (
                  <div className="pb-2 border-b border-slate-700 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      {buzzdetectCopy.seriesHeader}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => onSeriesModeChange('activation')}
                        className={`flex-1 px-2 py-1 rounded text-[11px] transition-colors ${seriesMode === 'activation' ? 'bg-[#e65161] text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                      >
                        {buzzdetectCopy.seriesActivation}
                      </button>
                      <button
                        onClick={() => onSeriesModeChange('detectionRate')}
                        className={`flex-1 px-2 py-1 rounded text-[11px] transition-colors ${seriesMode === 'detectionRate' ? 'bg-[#e65161] text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                      >
                        {buzzdetectCopy.seriesDetectionRate}
                      </button>
                    </div>
                  </div>
                )}
                {data && (
                  <div className="pb-2 border-b border-slate-700 space-y-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400">
                      <span>{buzzdetectCopy.binWidthHeader}</span>
                      {binWidthOverride !== null && (
                        <button
                          onClick={() => onBinWidthOverrideChange(null)}
                          className="text-slate-400 hover:text-[#e65161]"
                          data-tooltip={tooltips.buzzdetectBinWidthReset}
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </div>
                    <DraftNumberInput
                      value={binWidthOverride ?? autoBinWidthDisplay}
                      onCommit={(v) => { if (v === null) return; onBinWidthOverrideChange(v); }}
                      min={data.binWidth}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 outline-none focus:border-[#e65161]"
                    />
                  </div>
                )}
                {data && activeAutoYRange && (
                  <div className="pb-2 border-b border-slate-700 space-y-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400">
                      <span>{buzzdetectCopy.yAxisHeader}</span>
                      {yAxisOverride && (yAxisOverride.min !== activeAutoYRange.min || yAxisOverride.max !== activeAutoYRange.max) && (
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
                        value={yAxisOverride?.min ?? activeAutoYRange.min}
                        onCommit={(v) => {
                          if (v === null) return;
                          setYAxisOverride({ min: v, max: yAxisOverride?.max ?? activeAutoYRange.max });
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 outline-none focus:border-[#e65161]"
                      />
                      <span className="text-slate-500 text-xs flex-none">–</span>
                      <DraftNumberInput
                        value={yAxisOverride?.max ?? activeAutoYRange.max}
                        onCommit={(v) => {
                          if (v === null) return;
                          setYAxisOverride({ min: yAxisOverride?.min ?? activeAutoYRange.min, max: v });
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
