import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { Sliders, GripHorizontal, RotateCcw } from 'lucide-react';
import { BuzzdetectData, BuzzdetectSeriesMode, Selection } from '../types';
import type { ViewportStore } from '../utils/viewportStore';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import { Timeline, identityTimeline, segmentJoins, sourceIntervalOf } from '../utils/subsetTimeline';
import {
  buzzdetectNeuronColor,
  BUZZDETECT_PALETTE,
  DEFAULT_BUZZDETECT_THRESHOLD,
  MIN_BUZZDETECT_PANEL_HEIGHT,
  MAX_BUZZDETECT_PANEL_HEIGHT,
  Y_AXIS_WIDTH,
  DEFAULT_DATE_TIME_FORMAT,
} from '../constants';
import { clamp, decimalsForTimes, formatTimeForUnit, TimeDisplayUnit } from '../utils/helpers';
import type { DateTimeFormat } from '../utils/datetimeDisplay';
import { timeToX, xToTime } from '../utils/viewportTransform';
import type { FrameUnit } from '../utils/binIndex';
import {
  forEachUnitInSpan,
  frameRangeForTimeSpan,
  isGroupedUnitWidth,
  unitAtTime,
  visibleBinRange,
} from '../utils/binIndex';
import { shouldPromoteDragIntent } from '../utils/dragIntent';
import {
  buildPrefixSum,
  buildThresholdCountPrefix,
  buildAnyOverThresholdPrefix,
  rangeSum,
  rangeMean,
} from '../utils/prefixSums';
import { buzzdetectPanel as buzzdetectCopy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import DraftNumberInput from './DraftNumberInput';
import ColorSwatchPicker from './ColorSwatchPicker';

const PAD_TOP = 12;
const PAD_BOTTOM = 12;
// Above this many visible bins, average them into groups to keep the drawn
// polyline near this point count instead of a scratchy per-bin path.
const MAX_LINE_POINTS = 1000;
// Narrower than this on screen (px), unit boundaries are too tight to draw as
// separate hash marks — and by the same token too tight for a click to have
// meant one unit rather than its neighbour, so below it a click only seeks
// (see handleAreaMouseDown). One number for both: the user can aim at a unit
// exactly when they can see where it starts and ends.
const MIN_UNIT_BOUNDARY_PX = 6;
// Narrower than this, a per-frame dot is no longer legible as its own marker.
const MIN_DOT_PX = 4;
// Most decimal places the hover/selection readout ever shows a time to. Times
// carrying less precision than this are shown to less (see decimalsForTimes).
const READOUT_MAX_DECIMALS = 2;
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
  /** Wall-clock start of the track (null when unknown) — see Toolbar. */
  trackStartDate?: Date | null;
  /** Style for wall-clock datetimes in the hover readout. */
  dateTimeFormat?: DateTimeFormat;
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
  // ── Subset ────────────────────────────────────────────────────────────────
  // Whether the track is currently subset to these neurons' detections. When it
  // is, `data` has ALREADY been re-expressed on the subset's display axis by the
  // caller — this component never sees the hidden frames and needs no notion of
  // them. The flag is only used for drawing: with cuts in the axis, a line
  // between neighbouring points would imply continuity across a join that isn't
  // there, so the series is drawn as bare points.
  subsetActive: boolean;
  // Display->source map, same object the spectrogram draws against. Used here
  // only to mark the seams between spliced-together spans (see subsetJoins
  // below) — everything else about drawing stays in display time already.
  timeline?: Timeline;
  // Neuron labels the subset is keyed to (OR'd). Independent of `hiddenNeurons`:
  // a neuron can drive the subset while another is merely plotted alongside it.
  subsetNeurons: string[];
  // Minimum fraction of a bin's frames that must fire for the bin to be kept.
  // detection-rate mode only.
  minDetectionRate: number;
  height: number;
  // Callbacks.
  onThresholdChange: (neuron: string, value: number) => void;
  onToggleNeuron: (neuron: string, hidden: boolean) => void;
  // Show/hide every neuron in the graph at once (distinct from subsetting).
  onSetAllNeuronsHidden: (hidden: boolean) => void;
  onNeuronColorChange: (neuron: string, color: string) => void;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
  onToggleSubsetNeuron: (neuron: string, willSubset: boolean) => void;
  onMinDetectionRateChange: (rate: number) => void;
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
  trackStartDate = null,
  dateTimeFormat = DEFAULT_DATE_TIME_FORMAT,
  thresholds,
  hiddenNeurons,
  neuronColors: neuronColorOverrides,
  seriesMode,
  binWidthOverride,
  subsetActive,
  timeline,
  subsetNeurons,
  minDetectionRate,
  height,
  onThresholdChange,
  onToggleNeuron,
  onSetAllNeuronsHidden,
  onNeuronColorChange,
  onSeriesModeChange,
  onBinWidthOverrideChange,
  onToggleSubsetNeuron,
  onMinDetectionRateChange,
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
  // Hovered unit, as a frame-index range (inclusive) — one frame, or the whole
  // bucket frames are grouped into (see unitAtClientX).
  // Lives in a ref as well as state: the ref is what the overlay canvas paints
  // from (so a mousemove costs one cheap overlay repaint, not a React render
  // plus a full data-canvas redraw), and the state exists only to drive the DOM
  // readout — updated through `setHover` below, which drops no-op moves.
  const hoverRangeRef = useRef<FrameUnit | null>(null);
  const [hoverRange, setHoverRange] = useState<FrameUnit | null>(null);

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

  // Drag-to-select across hit units. `dragging` gates the window listeners; the
  // anchor unit lives in a ref so the listener effect attaches once per drag
  // rather than re-running as the selection updates. The unit is a single frame
  // when frames are individually visible and the whole bin otherwise (see
  // unitAtClientX), so a drag always snaps to discrete units either way.
  //
  // `pending` means the gesture has only seeked so far and hasn't selected
  // anything yet — see handleAreaMouseDown for when a mousedown starts pending.
  // It's promoted to a real selection by shouldPromoteDragIntent, the same
  // predicate the spectrogram uses, so a short click anywhere in the app leaves
  // only its seek behind. startX/startTime are what that predicate measures.
  const [dragging, setDragging] = useState(false);
  const dragAnchorRef = useRef<
    { unit: FrameUnit; pending: boolean; startX: number; startTime: number } | null
  >(null);

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

  // The bin width (seconds) currently in effect — auto or overridden — set at
  // draw time. It's what decides whether a unit is one frame or a whole bucket
  // (utils/binIndex), so hit-testing reading it here is what keeps clicking and
  // drawing in agreement: whatever a drag selects is what the panel drew.
  const effectiveBinWidthRef = useRef(0);

  // On-screen width (px) of one drawn unit — also set at draw time, and read by
  // the mousedown handler to decide whether a click may select outright (see
  // handleAreaMouseDown). It's the frame's width or the bin's, whichever the
  // unit currently is, because that's what the user is aiming at.
  const unitPxRef = useRef(0);

  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);

  // Display-time seams between spliced-together spans (see Spectrogram, which
  // marks the same positions) — empty whenever there's no subset to seam.
  const subsetJoins = useMemo(() => (timeline ? segmentJoins(timeline) : []), [timeline]);

  // The timeline every unit below is cut against. Memoised even in the identity
  // case so `draw` doesn't get a fresh dep object on every render.
  const fallbackTimeline = useMemo(() => identityTimeline(duration), [duration]);
  const activeTimeline = timeline ?? fallbackTimeline;

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

  // The current selection as a unit, for the persistent selection readout
  // below: the frames it covers (half-open on the right, so selecting exactly
  // one frame reads as one frame rather than spilling into its neighbour) and
  // its own time span. The span is the selection's, NOT the frames' — a 4s bin
  // over 0.96s frames holds five of them, whose extents reach to 4.8s, but the
  // bin is 4s and that's what was selected.
  const selectionUnit = useMemo<FrameUnit | null>(() => {
    if (!selection || !data) return null;
    const r = frameRangeForTimeSpan(data.starts, data.binWidth, selection.start, selection.end);
    return r && { ...r, tStart: selection.start, tEnd: selection.end };
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

  // The unit under the cursor — the one thing hovering highlights and a click
  // selects. Which unit that is follows exactly what's drawn, because the draw
  // loop enumerates units from the same module with the same width: one frame
  // while frames are resolved individually, else the whole bin the polyline
  // aggregates into the point under the cursor.
  const unitAtClientX = useCallback((clientX: number): FrameUnit | null => {
    if (!data || data.starts.length === 0) return null;
    const t = timeAtClientX(clientX);
    if (t === null) return null;
    // Null where the unit holds no frame — a gap between frames, or an empty
    // bucket. Nothing is drawn there either, so there's nothing to select. A
    // bin wider than a subset segment resolves to the piece cut at the
    // segment's edges, same as the drawn band (see utils/binIndex).
    return unitAtTime(activeTimeline, data.starts, data.binWidth, effectiveBinWidthRef.current, t);
  }, [data, timeAtClientX, activeTimeline]);

  // A unit's own time extent, end clamped to EOF — the same span the panel
  // washes and highlights, so a selection lands exactly on what the cursor
  // pointed at.
  const unitInterval = useCallback((u: FrameUnit): Selection => (
    { start: u.tStart, end: duration > 0 ? Math.min(u.tEnd, duration) : u.tEnd }
  ), [duration]);

  // Interval spanning two units — the drag anchor `a` and the unit under the
  // cursor, in either order — held inside the anchor's subset segment. Dragging
  // past a cut selects up to the segment edge and no further: the units on the
  // far side are elsewhere in the file, so a selection covering both would name
  // audio between them that was never shown. No-op with no subset.
  const unitSpan = useCallback((a: FrameUnit, b: FrameUnit): Selection => {
    const start = Math.min(a.tStart, b.tStart);
    const end = unitInterval(a.tEnd > b.tEnd ? a : b).end;
    return {
      start: activeTimeline.clampToSpanOfDisplay(a.tStart, start),
      end: activeTimeline.clampToSpanOfDisplay(a.tStart, end),
    };
  }, [unitInterval, activeTimeline]);

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

    // The unit width (seconds): above MAX_LINE_POINTS visible frames, an auto
    // width groups them so the drawn line stays near that point count instead
    // of a scratchy per-frame path; the user's override, if set, replaces that
    // auto width outright. Everything downstream — the bands, the darken pass,
    // the boundary marks, the polyline, and the cursor's hit-testing — works in
    // units of this width.
    const binPx = binWidth * pixelsPerSecond;
    const visibleCount = iRight - iLeft + 1;
    const autoBinWidthSec = visibleCount > MAX_LINE_POINTS ? (endTime - startTime) / MAX_LINE_POINTS : binWidth;
    const effectiveBinWidthSec = Math.max(binWidthOverride ?? autoBinWidthSec, binWidth);
    const grouped = isGroupedUnitWidth(binWidth, effectiveBinWidthSec);
    const drawDots = binPx >= MIN_DOT_PX && !grouped;
    // The width that decides what a unit is (utils/binIndex) — published for
    // the hover/click handlers, which resolve units by time through the same
    // functions this draw enumerates them with.
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

    // The units this viewport draws — one per frame, or one per bucket when
    // frames are grouped (utils/binIndex decides which; hit-testing resolves a
    // unit by time through the same module, so what's painted below is exactly
    // what the cursor can highlight and select). Below a pixel per frame,
    // materialising them would mean tens of thousands of entries on a long
    // recording, hundreds landing in the same pixel column, so each column's
    // frames stand in for the frames inside it — at most one entry per column.
    const subPixelFrames = binPx < 1 && !grouped;
    const units: { start: number; end: number; xStart: number; xEnd: number; xMid: number; tMid: number }[] = [];
    if (subPixelFrames) {
      const cols = Math.ceil(width);
      for (let c = 0; c < cols; c++) {
        const r = frameRangeForTimeSpan(
          starts,
          binWidth,
          xToTime(c, scrollLeft, pixelsPerSecond),
          xToTime(c + 1, scrollLeft, pixelsPerSecond),
        );
        if (r) units.push({ ...r, xStart: c, xEnd: c + 1, xMid: c + 0.5, tMid: xToTime(c + 0.5, scrollLeft, pixelsPerSecond) });
      }
    } else {
      // Buckets anchored to file time (utils/binIndex's sourceBucketPieces),
      // cut at the subset's segment boundaries: a bin wider than a segment
      // becomes one drawn unit per segment, so no band, point or wash reaches
      // across a cut into audio from elsewhere in the file. Hit-testing cuts
      // the same way, so what's painted stays what the cursor can pick.
      forEachUnitInSpan(activeTimeline, starts, binWidth, effectiveBinWidthSec, startTime, endTime, u => {
        units.push({
          start: u.start,
          end: u.end,
          xStart: xOf(u.tStart),
          xEnd: xOf(u.tEnd),
          xMid: xOf((u.tStart + u.tEnd) / 2),
          tMid: (u.tStart + u.tEnd) / 2,
        });
      });
    }
    // Width of one unit on screen, for the "is this too tight to draw?" gates —
    // and, published below, the "is this too tight to click?" one.
    const unitPx = grouped ? effectiveBinWidthSec * pixelsPerSecond : binPx;
    unitPxRef.current = unitPx;

    // Full-height wash over every unit satisfying `keep`. Adjacent painted
    // units are merged into one rect — that's what keeps a screen full of
    // sub-pixel units down to a handful of fills instead of one per unit.
    const paintUnits = (keep: (u: { start: number; end: number }) => boolean) => {
      let runStart = NaN;
      let runEnd = NaN;
      const flush = () => {
        if (!isNaN(runStart)) ctx.fillRect(runStart, 0, Math.max(1, runEnd - runStart), h);
        runStart = NaN;
      };
      for (const u of units) {
        if (u.xEnd < 0 || u.xStart > width) continue;
        if (!keep(u)) { flush(); continue; }
        // Half a pixel of slack: units that abut are one continuous band, and
        // rounding shouldn't punch hairline gaps into it.
        if (!isNaN(runStart) && u.xStart <= runEnd + 0.5) runEnd = Math.max(runEnd, u.xEnd);
        else { flush(); runStart = u.xStart; runEnd = u.xEnd; }
      }
      flush();
    };

    // Unit bands: a faint wash over the time each unit actually covers, so
    // uncovered time (frame length overridden shorter than the frame spacing,
    // or a bucket holding no frames) reads as bare background rather than an
    // implied contiguous grid.
    ctx.fillStyle = 'rgba(226, 232, 240, 0.045)';
    paintUnits(() => true);

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

    // Subset segment joins — the same seams the spectrogram marks, drawn the
    // same way (gold, dashed), so a cut reads identically on both: a splice,
    // not a marker unique to one panel.
    if (subsetJoins.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const t of subsetJoins) {
        const x = xOf(t);
        if (x < -1 || x > width + 1) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.restore();
    }

    // (The hovered bin/bin-group band lives on the overlay canvas — see
    // drawOverlay — so moving the cursor doesn't repaint this canvas.)

    // Darken units holding no detection at all, so detections pop by contrast
    // against a dimmed background. One rule for every unit size: exact for a
    // single frame (it's detected or it isn't), and for a unit covering many
    // frames it keeps a lone detection visible — the stricter "every frame
    // detected" would dim nearly everything and say nothing. The test is a
    // prefix-sum lookup, not a scan across frames and neurons.
    if (enabled.length > 0 && anyDetectedPrefix) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      paintUnits(u => rangeSum(anyDetectedPrefix, u.start, u.end) === 0);
    }

    // Soft vertical hash marks at unit boundaries (skip when they get tight).
    // Both edges of each unit are drawn, so an overridden binWidth — or a
    // bucket the frames don't fill — reads as separated units rather than a
    // contiguous grid.
    if (unitPx >= MIN_UNIT_BOUNDARY_PX) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const u of units) {
        for (const x of [u.xStart, u.xEnd]) {
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

    // Polylines + dots, one neuron at a time. In activation mode each point
    // is the mean activation over its bucket; in detection-rate mode it's
    // the fraction of the bucket's frames clearing the threshold (both are
    // just "average the per-frame value", differing only in what that
    // per-frame value is).
    for (const n of enabled) {
      const color = neuronColors[n];
      const th = thresholdOf(neurons[n]);
      const perFrameValue = (i: number) => seriesMode === 'activation' ? values[n][i] : (values[n][i] >= th ? 1 : 0);
      // Bucket aggregate, hoisted: the grouped polyline and the grouped dots
      // (drawn under a subset, where there is no polyline) both need it.
      const prefix = seriesMode === 'activation' ? activationPrefix?.[n] : detectionPrefix?.[n];
      const unitMean = (u: { start: number; end: number }) => (prefix ? rangeMean(prefix, u.start, u.end) : 0);

      // Under a subset the x-axis has cuts in it: consecutive points can be
      // minutes apart in the file even though they abut on screen, and a line
      // joining them would draw a trend across time that was removed. So the
      // path breaks (a moveTo instead of a lineTo) wherever the span changes —
      // points stay connected within a segment, never across one. Outside a
      // subset every point is in the one identity span, so this is exactly the
      // old unconditional polyline.
      //
      // A segment holding only ONE point has nothing to connect to — a lone
      // moveTo strokes nothing, so the neuron would silently vanish there.
      // `drawDots` already puts a dot on every point when frames are resolved
      // individually and wide enough to draw, so the gap only shows up
      // without it (grouped buckets, or frames too narrow for their own dot);
      // isolated points are tracked here and dotted in afterward, once it's
      // known no lineTo ever reached them.
      const spanAt = (t: number) => subsetActive ? activeTimeline.spanIndexAtDisplay(t) : 0;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      let lastSpan = -1;
      let pointsInSpan = 0;
      let lastX = 0;
      let lastY = 0;
      const isolatedPoints: { x: number; y: number }[] = [];
      const lineTo = (t: number, x: number, y: number) => {
        const spanIdx = spanAt(t);
        if (!started || spanIdx !== lastSpan) {
          if (started && pointsInSpan === 1) isolatedPoints.push({ x: lastX, y: lastY });
          ctx.moveTo(x, y);
          started = true;
          pointsInSpan = 0;
        } else {
          ctx.lineTo(x, y);
        }
        pointsInSpan++;
        lastX = x; lastY = y;
        lastSpan = spanIdx;
      };
      if (!grouped) {
        for (let i = iLeft; i <= iRight; i++) {
          const t = starts[i] + binWidth / 2;
          lineTo(t, xOf(t), yOf(perFrameValue(i)));
        }
      } else {
        // One point per unit, at its midpoint. Prefix-sum lookup, not a scan: a
        // unit can span hours of frames when the user pins a wide bin width,
        // and units are recomputed on every redraw (they're time-anchored, so
        // they're stable, but the draw path doesn't cache them).
        if (units.length === 1) {
          // Every frame in view falls in one unit (a wide override on a short
          // file): a lone moveTo strokes nothing and grouped mode draws no dots,
          // so the neuron would vanish. Stroke the unit's value flat across
          // its own x-extent instead.
          const cy = yOf(unitMean(units[0]));
          ctx.moveTo(units[0].xStart, cy);
          ctx.lineTo(units[0].xEnd, cy);
        } else {
          for (const u of units) {
            lineTo(u.tMid, u.xMid, yOf(unitMean(u)));
          }
        }
      }
      if (started && pointsInSpan === 1) isolatedPoints.push({ x: lastX, y: lastY });
      ctx.stroke();

      if (!drawDots) {
        ctx.fillStyle = color;
        for (const p of isolatedPoints) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

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
  }, [data, activeAutoYRange, yAxisOverride, binWidthOverride, seriesMode, subsetActive, subsetJoins, activeTimeline, showSettings, viewportStore, selection, enabled, activationPrefix, detectionPrefix, anyDetectedPrefix, neuronColors, thresholdOf, areaSize]);

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

    // Hovered unit band, over the unit's own extent — the same span the main
    // canvas washed and a click would select — brighter than the resting wash
    // so the click target still reads clearly on top of it. Read from a ref
    // rather than state so a mousemove never re-renders the component or
    // dirties the main canvas.
    const hr = hoverRangeRef.current;
    if (data && hr && hr.start >= 0 && hr.end < data.starts.length) {
      const hx = timeToX(hr.tStart, scrollLeft, pixelsPerSecond);
      const hEndX = timeToX(hr.tEnd, scrollLeft, pixelsPerSecond);
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
  const setHover = useCallback((r: FrameUnit | null) => {
    const prev = hoverRangeRef.current;
    if (prev === r) return;
    if (prev && r && prev.tStart === r.tStart && prev.tEnd === r.tEnd) return;
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

  // ── Unit selection (click + drag across frames or bins) ─────────────────────
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const unit = unitAtClientX(e.clientX);
      const anchor = dragAnchorRef.current;
      if (!unit || !anchor) return;
      if (anchor.pending) {
        if (!shouldPromoteDragIntent({
          containerWidth: areaRef.current?.clientWidth || 0,
          startX: anchor.startX,
          currentX: e.clientX,
          startTime: anchor.startTime,
          now: Date.now(),
        })) return;
        // Only now is this a selection gesture, so only now does it take the
        // selection away from whatever held it.
        anchor.pending = false;
        onBoundAnnotationChange(null);
      }
      onSelectionChange(unitSpan(anchor.unit, unit));
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
  }, [dragging, unitAtClientX, unitSpan, onSelectionChange, onBoundAnnotationChange]);

  const handleAreaMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-buzz-ui]')) return;
    if (e.button !== 0) return;
    // Whatever discrete unit is under the cursor — a frame while frames are
    // individually visible, else the whole bin. Zoomed out, a click can't pick
    // out a single frame meaningfully, so the bin is the unit; either way the
    // selection snaps to the highlighted region rather than to raw time.
    const unit = unitAtClientX(e.clientX);
    if (!unit) return;
    const interval = unitInterval(unit);

    // Shift+click extends the existing selection to also cover this unit,
    // merging the two ranges into one bounding interval. Using min/max of the
    // two ranges naturally handles overlap — the union of two overlapping
    // intervals is just their combined min/max.
    // Held inside the existing selection's segment, for the same reason a drag
    // is (see unitSpan): shift-clicking into another segment extends only as
    // far as the cut.
    if (e.shiftKey && selection) {
      const merged: Selection = {
        start: activeTimeline.clampToSpanOfDisplay(selection.start, Math.min(selection.start, interval.start)),
        end: activeTimeline.clampToSpanOfDisplay(selection.start, Math.max(selection.end, interval.end)),
      };
      onSelectionChange(merged);
      return;
    }

    // A click selects its unit outright — one frame or one bin is a meaningful
    // selection on its own, so it shouldn't take a drag across several to get
    // one. The drag that may follow just extends from this anchor.
    //
    // Except when the unit is drawn too narrow for its boundaries to be worth
    // marking — a sub-pixel frame, or a 4s bin in a 36h view. Nobody picks out
    // a band whose edges they can't see, so a click there reads as
    // repositioning the playhead. It only seeks, and stays pending until the
    // pointer moves or holds far enough to mean a selection (dragging a range
    // across a dense plot is still perfectly meaningful — it's the single unit
    // that isn't).
    const pending = unitPxRef.current < MIN_UNIT_BOUNDARY_PX;
    onSeek(interval.start);
    if (!pending) {
      onBoundAnnotationChange(null);
      onSelectionChange(interval);
    }
    dragAnchorRef.current = { unit, pending, startX: e.clientX, startTime: Date.now() };
    setDragging(true);
  };

  const handleAreaMouseMove = (e: React.MouseEvent) => {
    if (dragging) return; // drag handled at window level
    // The same unit a click would select — highlight and hit target can't disagree.
    setHover(unitAtClientX(e.clientX));
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

  // Renders the small top-left readout for a unit: its time span, and each
  // enabled neuron's value. One call site — it shows the selection's span when
  // there is a selection, else the hovered unit's.
  //
  // The span shown is the unit's own (tStart/tEnd), never the union of its
  // frames' extents: a bin is a span of time that some number of frames start
  // inside, and the last of those frames can end past it. The frames only say
  // what the values are averaged from.
  //
  // In activation mode: the raw value for a single frame, averaged across
  // the range otherwise. In detection-rate mode: just Detection/No Detection
  // for a single frame (a rate over one frame isn't meaningful — it's the
  // frame's own dot, drawn at 1 or 0), else the fraction of the range's
  // frames clearing the threshold.
  const renderBinRangeReadout = (unit: FrameUnit) => {
    if (!data) return null;
    const { start, end } = unit;
    // A hover range from the previous track outlives the render that swapped
    // `data` in (it's only cleared in an effect), so bail on out-of-range
    // indices here rather than reading past the new arrays.
    if (start < 0 || end < start || end >= data.starts.length) return null;
    const isSingle = start === end;
    // Shown in source time — a readout is something the user reads off and acts
    // on, and the only time that means anything outside this view is the file's.
    const { start: tStart, end: tEnd } = (() => {
      const i = unitInterval(unit);
      return sourceIntervalOf(activeTimeline, i.start, i.end);
    })();
    // Always a span, one frame included — a frame covers time like anything
    // else here, and collapsing it to its start time hides how much.
    //
    // Only as precise as the times being shown: whole-second bin edges read as
    // "4s", and one edge needing a decimal gives both of them one. Snapped to
    // the readout's own precision first, because the formatters truncate — an
    // edge that drifted to 101.9996 reads as 102s, and flooring the unsnapped
    // value would say 101s instead.
    const shown = [tStart, tEnd].map(t => Number(t.toFixed(READOUT_MAX_DECIMALS)));
    const dp = decimalsForTimes(shown, READOUT_MAX_DECIMALS);
    return (
      <div className="absolute top-1 left-2 pointer-events-none text-[10px] leading-tight font-mono bg-black/50 rounded px-1.5 py-1 max-w-[60%]">
        <div className="text-slate-400 font-bold">{buzzdetectCopy.timeReadoutHeader}</div>
        <div className="text-slate-300">
          {`${formatTimeForUnit(shown[0], timeDisplayUnit, dp, trackStartDate, dateTimeFormat)}–${formatTimeForUnit(shown[1], timeDisplayUnit, dp, trackStartDate, dateTimeFormat)}`}
        </div>
        <div className="text-slate-400 font-bold mt-1">
          {isSingle ? buzzdetectCopy.rawActivationsHeader : buzzdetectCopy.avgActivationsHeader}
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
                {n} {value.toFixed(2)}
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

          {/* A subset that kept nothing. Distinct from "no activations": the
              file has results, they just don't meet the criteria — so the fix
              is a lower threshold or rate, not a missing CSV. */}
          {data && data.starts.length === 0 && subsetActive && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-slate-600 text-xs">{buzzdetectCopy.subsetEmpty}</span>
            </div>
          )}

          {/* Readout — time range + each enabled neuron's value, in color.
              The current selection takes priority and stays put regardless
              of the cursor once one exists (so it can't be "stomped" by
              moving the mouse over the panel); only without a selection does
              it track the hovered bin (or bin-group). */}
          {data && (selectionUnit ?? hoverRange) !== null &&
            renderBinRangeReadout((selectionUnit ?? hoverRange)!)}

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
                {data && (
                  <div className="pb-2 border-b border-slate-700 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      {buzzdetectCopy.subsetHeader}
                    </div>
                    {subsetNeurons.length === 0 ? (
                      <p className="text-slate-500 text-[11px]">{buzzdetectCopy.subsetNoNeurons}</p>
                    ) : (
                      <>
                        {seriesMode === 'detectionRate' && (
                          <div className="flex items-center gap-2">
                            <span className="flex-1 text-[11px] text-slate-300">{buzzdetectCopy.subsetMinRateLabel}</span>
                            <DraftNumberInput
                              value={minDetectionRate}
                              onCommit={(v) => { if (v !== null) onMinDetectionRateChange(clamp(v, 0, 1)); }}
                              min={0}
                              className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-right text-slate-200 outline-none focus:border-[#e65161]"
                            />
                          </div>
                        )}
                        {/* The auto bin width changes with zoom, so subsetting by
                            it would silently redefine the subset every time the
                            view moved. A bin is kept whole, on the pinned width
                            instead (the file's frame length until one is
                            pinned, where a bin is just one frame) — its mean
                            activation in activation mode, its detection rate in
                            detection rate mode. */}
                        <p className="text-slate-500 text-[10px]">{buzzdetectCopy.subsetPinBinWidth}</p>
                      </>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 pb-1 border-b border-slate-700">
                  <span className="flex items-center gap-1.5">
                    {buzzdetectCopy.neuronHeader}
                    {data && data.neurons.length > 0 && (() => {
                      // One button whose action flips with the current state: while
                      // every neuron is shown, the only useful next step is hiding
                      // them all; otherwise (some or none shown) it's showing them
                      // all — so the label always names what a click is about to do.
                      const allShown = data.neurons.every(n => !hidden.has(n));
                      return (
                        <button
                          onClick={() => onSetAllNeuronsHidden(allShown)}
                          className="normal-case tracking-normal text-slate-400 hover:text-[#e65161] underline decoration-dotted"
                        >
                          {allShown ? buzzdetectCopy.selectNoneNeurons : buzzdetectCopy.selectAllNeurons}
                        </button>
                      );
                    })()}
                  </span>
                  <span className="flex items-center gap-2">
                    <span>{buzzdetectCopy.subsetColumnHeader}</span>
                    <span>{buzzdetectCopy.thresholdHeader}</span>
                  </span>
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
                      {/* Subsetting is deliberately independent of the plot
                          checkbox on the left: a neuron can define which frames
                          are kept while another is merely plotted alongside it
                          to see what it did there. Several ticked here are
                          OR'd — a frame survives if any of them fired. */}
                      <input
                        type="checkbox"
                        checked={subsetNeurons.includes(n)}
                        onChange={() => onToggleSubsetNeuron(n, !subsetNeurons.includes(n))}
                        className="accent-[#e65161] flex-none"
                        data-tooltip={tooltips.buzzdetectSubsetNeuron}
                      />
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
