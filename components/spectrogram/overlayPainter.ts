// The spectrogram's overlay canvases, as pure painters: everything drawn over
// the image — selection shading, the annotation-box preview, the playhead, the
// time ruler, the ident, and the band-pass band. Spectrogram.tsx decides what
// is on screen and in what order; these draw it, in CSS pixels.

import type { AnnotationTool } from '../../types';
import { annotationColorStyle, annotationBoxTop, ANNOTATION_BOX_HEIGHT } from '../../utils/helpers';
import type { TimeDisplayUnit } from '../../utils/helpers';
import { chooseTimeStep, formatRulerTime, rulerLabelAlign, rulerTicks, DATETIME_LABEL_SPACING_PX, RulerTick } from '../../utils/timeAxis';
import { datetimeTicks, formatDatetimeRulerLabel, DateTimeFormat } from '../../utils/datetimeDisplay';
import { timeToX } from '../../utils/viewportTransform';
import type { Timeline } from '../../utils/subsetTimeline';

/**
 * Darken everything outside a selection, and run a thin dotted spine down its
 * middle — the only thing a span still being swept out has to show for itself.
 * With a band-pass band up the spine runs down the middle of the band instead,
 * so the two read as the one region the audio is taken from.
 */
export function paintSelectionShade(
  ctx: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  width: number,
  height: number,
  band: { yTop: number; yBottom: number } | null,
): void {
  const x0 = Math.max(0, startX);
  const x1 = Math.min(width, endX);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  if (x0 > 0) ctx.fillRect(0, 0, x0, height);
  if (x1 < width) ctx.fillRect(x1, 0, width - x1, height);
  if (x1 <= x0) return;
  const midY = band ? (band.yTop + band.yBottom) / 2 : height / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x0, midY);
  ctx.lineTo(x1, midY);
  ctx.stroke();
  ctx.restore();
}

/**
 * The annotation box a span will become: same geometry and colours as the
 * committed box (AnnotationOverlay), in vertical layer `layerIndex`, with the
 * tool's label — just not interactive.
 */
export function paintAnnotationPreview(
  ctx: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  width: number,
  layerIndex: number,
  tool: AnnotationTool,
): void {
  const x0 = Math.max(0, startX);
  const x1 = Math.min(width, endX);
  if (x1 <= x0) return;
  const boxTop = annotationBoxTop(layerIndex);
  const style = annotationColorStyle(tool.color, false);
  const r = 4;
  const bottom = boxTop + ANNOTATION_BOX_HEIGHT;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0 + r, boxTop);
  ctx.lineTo(x1 - r, boxTop);
  ctx.arcTo(x1, boxTop, x1, boxTop + r, r);
  ctx.lineTo(x1, bottom - r);
  ctx.arcTo(x1, bottom, x1 - r, bottom, r);
  ctx.lineTo(x0 + r, bottom);
  ctx.arcTo(x0, bottom, x0, bottom - r, r);
  ctx.lineTo(x0, boxTop + r);
  ctx.arcTo(x0, boxTop, x0 + r, boxTop, r);
  ctx.closePath();
  ctx.fillStyle = style.bgColor;
  ctx.fill();
  ctx.strokeStyle = style.borderColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (x1 - x0 > 30) {
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tool.key === '0' ? 'Custom' : tool.text, x0 + 8, boxTop + ANNOTATION_BOX_HEIGHT / 2);
  }
  ctx.restore();
}

export function paintPlayhead(ctx: CanvasRenderingContext2D, x: number, width: number, height: number): void {
  if (x < 0 || x > width) return;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

export interface TimeRulerParams {
  width: number;
  height: number;
  scrollLeft: number;
  pixelsPerSecond: number;
  /** pixelsPerSecond the tick step is chosen from (the stable configured one). */
  stepPixelsPerSecond: number;
  startTime: number;
  endTime: number;
  duration: number;
  zoomSec: number;
  timeline: Timeline;
  timeDisplayUnit: TimeDisplayUnit;
  trackStartDate: Date | null;
  dateTimeFormat: DateTimeFormat;
}

/**
 * Ticks and labels along the bottom edge. Labelled in SOURCE time: under a
 * subset the display axis says nothing about where in the file you are, so
 * the ruler is built per kept span from that span's own file times (see
 * utils/timeAxis), and each label is left-aligned to its tick at a segment's
 * start — centring would make it read as spanning both sides of the cut.
 */
export function paintTimeRuler(ctx: CanvasRenderingContext2D, p: TimeRulerParams): void {
  // Datetime ticks land on wall-clock boundaries (the hour, the minute) and
  // carry wider labels, so both the spacing and the tick positions differ from
  // the elapsed-time ruler's multiples-of-step-from-zero.
  const datetimeRuler = p.timeDisplayUnit === 'datetime' && p.trackStartDate !== null;
  const timeStep = chooseTimeStep(p.stepPixelsPerSecond, datetimeRuler ? DATETIME_LABEL_SPACING_PX : undefined);

  ctx.font = 'bold 12px sans-serif';
  ctx.textBaseline = 'bottom';

  const tickEndTime = p.duration > 0 ? Math.min(p.endTime, p.duration) : p.endTime;
  // Wall-clock ticks only land on clock boundaries when the axis runs
  // continuously; under a subset the display axis is spliced, so ticks come
  // from the timeline (one per segment start) and are simply *labelled* as
  // datetimes. Either way each tick carries the source time its label reads.
  const ticks: RulerTick[] = datetimeRuler && p.timeline.identity
    ? datetimeTicks(p.trackStartDate!, Math.max(p.startTime, 0), tickEndTime, timeStep).map(s => ({ disp: s, src: s }))
    : rulerTicks(p.timeline, p.startTime, tickEndTime, timeStep, p.pixelsPerSecond,
        datetimeRuler ? DATETIME_LABEL_SPACING_PX : undefined);
  const labelAlign = rulerLabelAlign(p.timeline);
  ctx.textAlign = labelAlign;

  // Only labels actually drawn feed the "what changed since the last label"
  // logic, so scrolling never leaves a view whose first label lacks its date.
  let prevLabelled: number | null = null;
  for (const tick of ticks) {
    const x = timeToX(tick.disp, p.scrollLeft, p.pixelsPerSecond);
    if (x < 0 || x > p.width) continue;
    ctx.beginPath();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.moveTo(x, p.height);
    ctx.lineTo(x, p.height - 8);
    ctx.stroke();

    const timeStr = datetimeRuler
      ? formatDatetimeRulerLabel(p.trackStartDate!, tick.src, prevLabelled, timeStep, p.dateTimeFormat)
      : formatRulerTime(tick.src, timeStep, p.zoomSec, p.timeDisplayUnit === 'seconds');
    prevLabelled = tick.src;
    // The leading full-date label is wide enough to hang off the left edge;
    // nudge it back on-canvas rather than letting it clip.
    let labelX = labelAlign === 'left' ? x + 3 : x;
    if (datetimeRuler && labelAlign === 'center') {
      labelX = Math.max(labelX, ctx.measureText(timeStr).width / 2 + 2);
    }
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.strokeText(timeStr, labelX, p.height - 10);
    ctx.fillStyle = 'white';
    ctx.fillText(timeStr, labelX, p.height - 10);
  }
}

/** The track's ident, top-left. */
export function paintIdent(ctx: CanvasRenderingContext2D, ident: string): void {
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(ident, 8, 6);
}

/**
 * The band-pass band. 'active': everything outside it darkened by its strength
 * and its edges drawn blue. 'dormant': the filter exists but isn't applied
 * here right now (Mixed mode outside a selection), so only grey edges.
 * 'hidden': it has no effect at all (Fast mode), so nothing.
 */
export function paintFilterBand(
  ctx: CanvasRenderingContext2D,
  band: { yTop: number; yBottom: number; strength: number },
  width: number,
  height: number,
  state: 'active' | 'dormant' | 'hidden',
): void {
  if (state === 'hidden') return;
  if (state === 'active') {
    ctx.fillStyle = `rgba(0, 0, 0, ${0.65 * band.strength})`;
    if (band.yTop > 0) ctx.fillRect(0, 0, width, band.yTop);
    if (band.yBottom < height) ctx.fillRect(0, band.yBottom, width, height - band.yBottom);
  }
  ctx.strokeStyle = state === 'active' ? '#60a5fa' : '#64748b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, band.yTop); ctx.lineTo(width, band.yTop);
  ctx.moveTo(0, band.yBottom); ctx.lineTo(width, band.yBottom);
  ctx.stroke();
}
