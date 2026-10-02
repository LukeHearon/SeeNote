// Canvas painters shared by the spectrogram, the buzzdetect panel docked under
// it, and the example-clip spectrogram, so the gutter, the frequency ticks and
// the subset seams look (and line up) the same everywhere they appear.

import type { SpectrogramSettings } from '../../types';
import { freqAxisTicks, freqToY, formatFreqHz } from '../../utils/audioProcessing';
import { syncCanvasBitmap } from '../../utils/canvasDpr';
import { timeToX } from '../../utils/viewportTransform';
import { MIN_SEGMENT_JOIN_PX } from '../../utils/subsetTimeline';
import { Y_AXIS_WIDTH } from '../../constants';

const GUTTER_TONES = {
  // The spectrogram's own gutter sits over the image, so it is translucent.
  spectrogram: { bg: 'rgba(15, 23, 42, 0.7)', border: 'rgba(255,255,255,0.2)', text: 'rgba(255,255,255,0.8)' },
  panel: { bg: 'rgba(11,18,32,0.85)', border: 'rgba(255,255,255,0.15)', text: 'rgba(255,255,255,0.7)' },
} as const;

/**
 * Size, clear and frame a Y-axis gutter canvas (background, right border, label
 * font, right-aligned), then hand `paint` a context in CSS pixels.
 */
export function paintGutter(
  canvas: HTMLCanvasElement,
  cssHeight: number,
  tone: keyof typeof GUTTER_TONES,
  paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { dpr, width, height } = syncCanvasBitmap(canvas, Y_AXIS_WIDTH, cssHeight);
  const c = GUTTER_TONES[tone];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.beginPath();
  ctx.moveTo(width - 1, 0);
  ctx.lineTo(width - 1, height);
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = c.text;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  paint(ctx, width, height);
  ctx.restore();
}

/**
 * Frequency ticks and labels down a gutter, through the same freq→y mapping
 * the spectrogram renderer uses so they can't drift from the image. Ticks
 * within `edgeReservedPx` of either end are skipped (where something else
 * already shows the endpoint), as is any tick crowding the previous label.
 */
export function paintFrequencyTicks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  settings: Pick<SpectrogramSettings, 'minFreq' | 'maxFreq' | 'frequencyScale'>,
  edgeReservedPx = 0,
): void {
  const MIN_LABEL_SPACING = 13;
  let lastLabelY: number | null = null;
  for (const freq of freqAxisTicks(settings.minFreq, settings.maxFreq, settings.frequencyScale)) {
    const y = freqToY(freq, height, settings.minFreq, settings.maxFreq, settings.frequencyScale);
    if (y < edgeReservedPx || y > height - edgeReservedPx) continue;
    if (lastLabelY !== null && Math.abs(y - lastLabelY) < MIN_LABEL_SPACING) continue;
    lastLabelY = y;
    ctx.beginPath();
    ctx.moveTo(width - 5, y);
    ctx.lineTo(width - 1, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.stroke();
    ctx.fillText(formatFreqHz(freq), width - 7, y);
  }
}

/**
 * The subset's segment joins: gold dashed seams, so a cut reads as a splice
 * the same way on every canvas. Skipped when segments are too narrow on screen
 * for the seams to mean anything (they would merge into a solid wall).
 */
export function paintSubsetJoins(
  ctx: CanvasRenderingContext2D,
  joins: readonly number[],
  minSegmentSec: number,
  scrollLeft: number,
  pixelsPerSecond: number,
  width: number,
  height: number,
): void {
  if (joins.length === 0 || minSegmentSec * pixelsPerSecond < MIN_SEGMENT_JOIN_PX) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const t of joins) {
    const x = timeToX(t, scrollLeft, pixelsPerSecond);
    if (x < -1 || x > width + 1) continue;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.restore();
}
