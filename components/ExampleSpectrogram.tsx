import React, { useCallback, useEffect, useRef } from 'react';
import { SpectrogramSettings } from '../types';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { drawSpectrogramChunk, freqToY, freqAxisTicks } from '../utils/audioProcessing';
import { chooseTimeStep, formatRulerTime } from '../utils/timeAxis';
import type { CurrentTimeStore } from '../utils/currentTimeStore';

interface Props {
  filePath: string;
  sampleRate: number;
  duration: number;
  settings: SpectrogramSettings;
  /** Playhead time (seconds), pub/sub so playback ticks don't re-render the tree. */
  currentTimeStore: CurrentTimeStore;
  onSeek: (timeSec: number) => void;
}

const Y_AXIS_WIDTH = 50;

/**
 * Read-only spectrogram for the example-clip library. Reuses the same
 * primitives as the main Spectrogram (MultiTierSpectrogramCache for chunk
 * fetch/cache, drawSpectrogramChunk for the pixel/colormap/freq-axis work, the
 * shared freqToY/freqAxisTicks/timeAxis helpers, the shared time→pixel
 * convention) but renders the WHOLE clip statically across the canvas width —
 * no scroll, no incremental path, no annotation/selection/filter overlays.
 * Example clips are short, so a single full-width render is fine and far
 * simpler than the scrolling pipeline.
 *
 * The spectrogram is rendered once into an offscreen canvas (rebuilt only when
 * data/size/settings change); each playhead tick just blits that and redraws
 * the playhead + time ruler, so playback doesn't re-run the per-pixel colormap.
 * A separate left-hand canvas draws the frequency (Y) axis, mirroring the main
 * Spectrogram so it is never layered on top of spectrogram content.
 */
export default function ExampleSpectrogram({ filePath, sampleRate, duration, settings, currentTimeStore, onSeek }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const yAxisCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const cacheVersionRef = useRef(0);

  // Draw the frequency (Y) axis into its own canvas. Mirrors Spectrogram.tsx's
  // drawYAxis, using the shared freqToY/freqAxisTicks so ticks stay in lockstep
  // with the rendered spectrogram.
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
    for (const freq of freqAxisTicks(settings.minFreq, settings.maxFreq, settings.frequencyScale)) {
      const y = freqToY(freq, height, settings.minFreq, settings.maxFreq, settings.frequencyScale);
      if (y < 0 || y > height) continue;
      if (lastLabelY !== null && Math.abs(y - lastLabelY) < MIN_LABEL_SPACING) continue;
      lastLabelY = y;
      ctx.beginPath();
      ctx.moveTo(width - 5, y);
      ctx.lineTo(width - 1, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();
      let label = freq.toString();
      if (freq >= 1000) label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
      ctx.fillText(label, width - 7, y);
    }
    ctx.restore();
  }, [settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Blit the rendered offscreen spectrogram, then the time ruler + playhead,
  // onto the visible canvas. Cheap enough to call every animation tick.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const offscreen = offscreenRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cssW, cssH);
    if (offscreen && offscreen.width > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, cssW, cssH);
    }

    // Time ruler along the bottom (whole clip spans the canvas width).
    if (duration > 0) {
      const timeStep = chooseTimeStep(duration);
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let s = timeStep; s <= duration; s += timeStep) {
        const x = (s / duration) * cssW;
        ctx.beginPath();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.moveTo(x, cssH);
        ctx.lineTo(x, cssH - 8);
        ctx.stroke();
        const timeStr = formatRulerTime(s, timeStep, duration);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.strokeText(timeStr, x, cssH - 10);
        ctx.fillStyle = 'white';
        ctx.fillText(timeStr, x, cssH - 10);
      }

      // Playhead — only while within the clip.
      const t = currentTimeStore.get();
      if (t > 0 && t <= duration) {
        const x = (t / duration) * cssW;
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(x - 1, 0, 2, cssH);
      }
    }
    ctx.restore();
  }, [currentTimeStore, duration]);

  // Rebuild the offscreen spectrogram buffer from the chunk cache. Mirrors the
  // full-redraw column-assembly loop in Spectrogram.tsx, but over the entire
  // clip [0, duration] rather than a scrolled viewport.
  const renderSpectrogram = useCallback(() => {
    const canvas = canvasRef.current;
    const cache = cacheRef.current;
    if (!canvas || !cache || duration <= 0) return;

    const cssWidth = canvas.width / (window.devicePixelRatio || 1);
    if (cssWidth <= 0) return;
    const tier = cache.selectTier(duration, cssWidth);
    cache.prefetchViewport(0, duration, tier.tier);
    const cps = tier.colsPerSec;

    const bbWidth = Math.max(1, Math.ceil(duration * cps));
    let nFreqBins = settings.fftSize / 2;
    const probe = cache.getChunkWithFallback(0, tier.tier);
    if (probe) nFreqBins = probe.chunk.nFreqBins;

    const viewportData = new Uint16Array(bbWidth * nFreqBins);
    const colBuilt = new Uint8Array(bbWidth);
    for (let i = 0; i < bbWidth; i++) {
      const t = i / cps;
      if (t >= duration) continue;
      const result = cache.getChunkWithFallback(t, tier.tier);
      if (!result) continue;
      const { chunk } = result;
      if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) continue;
      const chunkCps = chunk.nCols / chunk.actualDurationSec;
      let col = Math.round((t - chunk.startSec) * chunkCps);
      if (col < 0) col = 0;
      if (col >= chunk.nCols) col = chunk.nCols - 1;
      const bins = Math.min(nFreqBins, chunk.nFreqBins);
      const srcOffset = col * chunk.nFreqBins;
      viewportData.set(chunk.data.subarray(srcOffset, srcOffset + bins), i * nFreqBins);
      colBuilt[i] = 1;
    }

    if (!offscreenRef.current) offscreenRef.current = document.createElement('canvas');
    const offscreen = offscreenRef.current;
    if (offscreen.width !== bbWidth) offscreen.width = bbWidth;
    if (offscreen.height !== canvas.height) offscreen.height = canvas.height;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;
    drawSpectrogramChunk(
      offCtx, viewportData, bbWidth, nFreqBins,
      offscreen.width, offscreen.height,
      settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
      settings.displayFloor, settings.displayCeil,
      colBuilt,
    );
    paint();
    drawYAxis();
  }, [duration, sampleRate, settings, paint, drawYAxis]);

  // (Re)create the cache when the clip or FFT size changes. The onChunkLoaded
  // callback bumps a version and re-renders as chunks stream in.
  useEffect(() => {
    if (!filePath || duration <= 0) return;
    const cache = new MultiTierSpectrogramCache(
      filePath, settings.fftSize, sampleRate, duration,
      () => { cacheVersionRef.current += 1; renderSpectrogram(); },
    );
    cacheRef.current = cache;
    renderSpectrogram();
    return () => { cacheRef.current = null; };
    // renderSpectrogram intentionally omitted: it changes with settings, but a
    // settings-only change is handled by the separate effect below (no need to
    // throw away the cache and re-decode).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sampleRate, duration, settings.fftSize]);

  // Re-render (not re-decode) when display settings change.
  useEffect(() => { renderSpectrogram(); }, [renderSpectrogram]);

  // Redraw the playhead/ruler on every time-store tick.
  useEffect(() => currentTimeStore.subscribe(paint), [currentTimeStore, paint]);

  // Keep the canvas backing store sized to the container (DPR-aware).
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(container.clientWidth * dpr));
      const h = Math.max(1, Math.floor(container.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        const yAxis = yAxisCanvasRef.current;
        if (yAxis) { yAxis.width = Y_AXIS_WIDTH * dpr; yAxis.height = h; }
        renderSpectrogram();
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [renderSpectrogram]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(duration, frac * duration)));
  };

  return (
    <div className="flex w-full h-full bg-[#0f172a]">
      <canvas ref={yAxisCanvasRef} className="h-full flex-shrink-0 pointer-events-none" style={{ width: Y_AXIS_WIDTH }} />
      <div ref={containerRef} className="relative flex-1 h-full">
        <canvas ref={canvasRef} className="w-full h-full block cursor-pointer" onClick={handleClick} />
      </div>
    </div>
  );
}
