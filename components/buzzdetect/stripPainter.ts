// The buzzdetect panel's data strip: background, unit washes, threshold lines,
// the per-neuron series (polyline or dots), detection highlights, subset seams
// and the Y-axis labels, painted over a window wider than the viewport so a
// pan can blit instead of repainting (see BuzzdetectPanel's draw).

import type { MutableRefObject, RefObject } from 'react';
import type { BuzzdetectData, BuzzdetectSeriesMode } from '../../types';
import type { Timeline } from '../../utils/subsetTimeline';
import { Y_AXIS_WIDTH } from '../../constants';
import { timeToX, xToTime } from '../../utils/viewportTransform';
import { forEachUnitInSpan, frameRangeForTimeSpan, visibleBinRange } from '../../utils/binIndex';
import { rangeMean, rangeSum } from '../../utils/prefixSums';
import { buzzdetectPanel as buzzdetectCopy } from '../../copy/ui';
import { paintGutter, paintSubsetJoins } from '../spectrogram/canvasPainters';

export const PAD_TOP = 12;
export const PAD_BOTTOM = 12;
// Narrower than this on screen (px), unit boundaries are too tight to draw as
// separate hash marks — and by the same token too tight for a click to have
// meant one unit rather than its neighbour, so below it a click only seeks
// (see BuzzdetectPanel's handleAreaMouseDown). One number for both: the user
// can aim at a unit exactly when they can see where it starts and ends.
export const MIN_UNIT_BOUNDARY_PX = 6;
// Alpha the other neurons drop to while one is isolated. Far enough back that
// the isolated line reads alone at a glance, still visible as context.
export const ISOLATED_ALPHA = 0.15;

export interface StripParams {
  stripCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  yAxisCanvasRef: RefObject<HTMLCanvasElement>;
  /** Receives the value→y mapping this paint used, for hit-testing. */
  yOfRef: MutableRefObject<((v: number) => number) | null>;
  dpr: number;
  /** Strip height, CSS px. */
  h: number;
  pixelsPerSecond: number;
  data: BuzzdetectData;
  seriesMode: BuzzdetectSeriesMode;
  yAxisOverride: { min: number; max: number } | null;
  activeAutoYRange: { min: number; max: number } | null;
  enabled: number[];
  thresholdOf: (neuron: string) => number;
  offsetOf: (n: number) => number;
  adjusting: boolean;
  binaryDetection: boolean;
  drawDots: boolean;
  grouped: boolean;
  hopPx: number;
  unitPx: number;
  effectiveBinWidthSec: number;
  activeTimeline: Timeline;
  subsetActive: boolean;
  subsetJoins: number[];
  minSegmentSec: number;
  activationPrefix: Float64Array[] | null;
  validCountPrefix: Float64Array[] | null;
  detectionPrefix: Float64Array[] | null;
  anyDetectedPrefix: Float64Array | null;
  neuronColors: string[];
  isolatedNeurons: readonly string[];
}

/**
 * Paint the strip for [originScroll, originScroll + stripWidthCss) into
 * `p.stripCanvasRef` (created on first use). False when there is nothing to
 * paint there.
 */
export function renderStrip(p: StripParams, originScroll: number, stripWidthCss: number): boolean {
  const {
    stripCanvasRef, yAxisCanvasRef, yOfRef, dpr, h, pixelsPerSecond, data, seriesMode,
    yAxisOverride, activeAutoYRange, enabled, thresholdOf, offsetOf, adjusting,
    binaryDetection, drawDots, grouped, hopPx, unitPx, effectiveBinWidthSec,
    activeTimeline, subsetActive, subsetJoins, minSegmentSec,
    activationPrefix, validCountPrefix, detectionPrefix, anyDetectedPrefix,
    neuronColors, isolatedNeurons,
  } = p;
  const { starts, frameLength, neurons, values } = data;
  let strip = stripCanvasRef.current;
  if (!strip) { strip = document.createElement('canvas'); stripCanvasRef.current = strip; }
  const wantW = Math.ceil(stripWidthCss * dpr);
  const wantH = Math.ceil(h * dpr);
  if (strip.width !== wantW) strip.width = wantW;
  if (strip.height !== wantH) strip.height = wantH;
  const ctx = strip.getContext('2d');
  if (!ctx) return false;
  const width = stripWidthCss;
  const startTime = originScroll / pixelsPerSecond;
  const endTime = startTime + width / pixelsPerSecond;
  const xOf = (t: number) => timeToX(t, originScroll, pixelsPerSecond);
  // The strip's window contains the viewport's, so this can only be null if
  // the viewport's was — which returned above.
  const stripVisible = visibleBinRange(starts, frameLength, startTime, endTime);
  if (!stripVisible) return false;
  const { iLeft, iRight } = stripVisible;

  ctx.clearRect(0, 0, strip.width, strip.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  // Background.
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, width, h);

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
      if (!isFinite(th)) continue;
      const y = th - offsetOf(n);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
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
  yOfRef.current = yOf;

  // The units this viewport draws — one per frame, or one per bucket when
  // frames are grouped (utils/binIndex decides which; hit-testing resolves a
  // unit by time through the same module, so what's painted below is exactly
  // what the cursor can highlight and select). Below a pixel per frame,
  // materialising them would mean tens of thousands of entries on a long
  // recording, hundreds landing in the same pixel column, so each column's
  // frames stand in for the frames inside it — at most one entry per column.
  const subPixelFrames = hopPx < 1 && !grouped;
  const units: { start: number; end: number; xStart: number; xEnd: number; xMid: number; tMid: number }[] = [];
  if (subPixelFrames) {
    const cols = Math.ceil(width);
    for (let c = 0; c < cols; c++) {
      const r = frameRangeForTimeSpan(
        starts,
        frameLength,
        xToTime(c, originScroll, pixelsPerSecond),
        xToTime(c + 1, originScroll, pixelsPerSecond),
      );
      if (r) units.push({ ...r, xStart: c, xEnd: c + 1, xMid: c + 0.5, tMid: xToTime(c + 0.5, originScroll, pixelsPerSecond) });
    }
  } else {
    // Buckets anchored to file time (utils/binIndex's sourceBucketPieces),
    // cut at the subset's segment boundaries: a bin wider than a segment
    // becomes one drawn unit per segment, so no band, point or wash reaches
    // across a cut into audio from elsewhere in the file. Hit-testing cuts
    // the same way, so what's painted stays what the cursor can pick.
    forEachUnitInSpan(activeTimeline, data, effectiveBinWidthSec, startTime, endTime, u => {
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

  // Subset segment joins — the same seams the spectrogram marks, drawn the
  // same way (gold, dashed), so a cut reads identically on both: a splice,
  // not a marker unique to one panel.
  paintSubsetJoins(ctx, subsetJoins, minSegmentSec, originScroll, pixelsPerSecond, width, h);

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

  // Isolation, applied as an alpha on everything a neuron draws: its line,
  // its dots and its threshold. A fade, not a filter — the other neurons
  // stay on screen as the context the isolated ones are being read against.
  const alphaOf = (n: number) => (
    isolatedNeurons.length > 0 && !isolatedNeurons.includes(neurons[n]) ? ISOLATED_ALPHA : 1
  );

  // Per-neuron threshold lines (dashed, in the neuron's color) — only in
  // activation mode; a detection rate isn't in the threshold's units.
  if (seriesMode === 'activation') {
    ctx.setLineDash([4, 4]);
    for (const n of enabled) {
      const th = thresholdOf(neurons[n]);
      if (!isFinite(th)) continue;
      const y = yOf(th - offsetOf(n));
      ctx.globalAlpha = alphaOf(n);
      ctx.strokeStyle = neuronColors[n] + '66';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Polylines + dots, one neuron at a time. In activation mode each point
  // is the mean activation over its bucket; in detection-rate mode it's
  // the fraction of the bucket's frames clearing the threshold (both are
  // just "average the per-frame value", differing only in what that
  // per-frame value is).
  for (const n of enabled) {
    const color = neuronColors[n];
    ctx.globalAlpha = alphaOf(n);
    const th = thresholdOf(neurons[n]);
    const off = offsetOf(n);
    // NaN for a missing frame in EITHER mode — not just when its own raw
    // value is read directly — so a frame with no value never renders as
    // a fake "undetected" point in detection-rate mode either.
    const perFrameValue = (i: number) => {
      const raw = values[n][i];
      if (Number.isNaN(raw)) return NaN;
      return seriesMode === 'activation' ? raw - off : (raw >= th ? 1 : 0);
    };
    // Bucket aggregate, hoisted: the grouped polyline and the grouped dots
    // (drawn under a subset, where there is no polyline) both need it.
    const prefix = seriesMode === 'activation' ? activationPrefix?.[n] : detectionPrefix?.[n];
    const unitMean = (u: { start: number; end: number }) =>
      (prefix ? rangeMean(prefix, u.start, u.end, validCountPrefix?.[n]) : 0) - off;

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
      // A missing frame is skipped rather than plotted — the line simply
      // paths over it, connecting its neighbours as if it weren't there.
      for (let i = iLeft; i <= iRight; i++) {
        const v = perFrameValue(i);
        if (Number.isNaN(v)) continue;
        const t = starts[i] + frameLength / 2;
        lineTo(t, xOf(t), yOf(v));
      }
    } else {
      // One point per unit, at its midpoint. Prefix-sum lookup, not a scan: a
      // unit can span hours of frames when the user pins a wide bin width,
      // and units are recomputed on every redraw (they're time-anchored, so
      // they're stable, but the draw path doesn't cache them).
      // A unit whose frames are all missing has nothing to plot — unitMean
      // returns NaN for it — so it's skipped the same as a single missing
      // frame above.
      if (units.length === 1) {
        // Every frame in view falls in one unit (a wide override on a short
        // file): a lone moveTo strokes nothing and grouped mode draws no dots,
        // so the neuron would vanish. Stroke the unit's value flat across
        // its own x-extent instead.
        const cy = yOf(unitMean(units[0]));
        if (!Number.isNaN(cy)) {
          ctx.moveTo(units[0].xStart, cy);
          ctx.lineTo(units[0].xEnd, cy);
        }
      } else {
        for (const u of units) {
          const v = unitMean(u);
          if (Number.isNaN(v)) continue;
          lineTo(u.tMid, u.xMid, yOf(v));
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
        if (Number.isNaN(values[n][i])) continue;
        const cx = xOf(starts[i] + frameLength / 2);
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
  ctx.globalAlpha = 1;

  ctx.restore();

  // Y-axis labels in the gutter canvas.
  const yCanvas = yAxisCanvasRef.current;
  if (yCanvas) {
    paintGutter(yCanvas, h, 'panel', (yctx) => {
      if (binaryDetection) {
        const yTop = yOf(1);
        if (yTop >= 8 && yTop <= h - 6) yctx.fillText(buzzdetectCopy.detection, Y_AXIS_WIDTH - 6, yTop, Y_AXIS_WIDTH - 8);
      } else if (!adjusting) {
        // Adjusted, every line is shifted by its own amount, so no one
        // number would be true of a height — the axis goes unlabelled.
        const TICKS = 4;
        for (let k = 0; k <= TICKS; k++) {
          const v = yMin + (k / TICKS) * (yMax - yMin);
          const y = yOf(v);
          if (y < 8 || y > h - 6) continue;
          yctx.fillText(seriesMode === 'activation' ? v.toFixed(1) : `${(v * 100).toFixed(0)}%`, Y_AXIS_WIDTH - 6, y);
        }
      }
    });
  }
  return true;
}
