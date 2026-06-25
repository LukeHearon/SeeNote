import React, { useCallback, useRef } from 'react';
import { SpectrogramSettings } from '../types';
import { drawSpectrogramChunk } from '../utils/audioProcessing';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';

export interface ChunkRendererParams {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  scrollLeft: number;
  pixelsPerSecond: number;
  duration: number;
  settings: SpectrogramSettings;
  isProcessing: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  offscreenCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  setIsBuilding: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface ChunkRendererApi {
  /** Stable per-deps draw callback for the spectrogram background. */
  draw: () => void;
}

/**
 * Owns the two-stage spectrogram chunk-rendering pipeline that was previously
 * inline in Spectrogram.tsx. Stage 1 builds a column-resolution viewport buffer
 * from the chunk cache (incremental self-blit or full redraw) into an offscreen
 * canvas; stage 2 blits that offscreen canvas to the visible canvas with a
 * sub-pixel destination shift for smooth panning. Also reconciles the
 * build-progress veil via the `setIsBuilding` setter.
 *
 * Pure extraction — no behavior or rendering-math change. The caller still owns
 * `drawRef`, the rAF loop, the dirty flags, the layout effects, and the
 * ResizeObserver; this hook only returns the `draw` function and owns the
 * reusable buffer pools and incremental-scroll state internally.
 */
export function useChunkRenderer({
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
}: ChunkRendererParams): ChunkRendererApi {
  // Reusable buffers for draw() — allocated once and grown as needed, never freed.
  // Avoids the ~500KB-per-frame Uint16Array allocation that causes GC pauses.
  const viewportDataBuf = useRef<Uint16Array>(new Uint16Array(0));
  const colBuiltBuf = useRef<Uint8Array>(new Uint8Array(0));
  // Same grow-only reuse for the incremental-scroll path's new-column buffers,
  // which otherwise allocated a fresh pair every animation frame during playback.
  const incrVdBuf = useRef<Uint16Array>(new Uint16Array(0));
  const incrCbBuf = useRef<Uint8Array>(new Uint8Array(0));

  // Incremental-scroll state: tracks what the offscreen canvas last rendered so
  // draw() can shift it by columnsShifted and only paint the new right-edge columns.
  const prevBbStartColRef = useRef<number | null>(null);
  const prevCacheVersionRef = useRef<number>(-1);
  // Tiny canvas for rendering 1-2 new columns per frame in the incremental path.
  const incrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Scratch canvas for the area-average pre-shrink step in stage 2.
  const preshrinkCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // True while the visible viewport still has chunks resolving (first load or a
  // settings-driven rebuild). Drives the "building spectrogram" veil. Computed
  // inside `draw` (which already knows the active tier and iterates columns) and
  // mirrored into a ref so setState only fires on an actual transition — never
  // every frame, which would loop draw→render→draw.
  const isBuildingRef = useRef(false);

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

    // Recomputed below: true while the visible range is still being built.
    let building = false;

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

        // "Building" = the visible range isn't yet fully resolved at the active
        // tier (so columns are missing or drawn blurry from a coarser fallback),
        // with in-flight fetches as a corroborating signal. Both probes are
        // read-only — they never mutate tier hysteresis or LRU order.
        building =
          !chunkCache.isViewportResolved(startTime, endTime, activeTier.tier) &&
          chunkCache.pendingCount() > 0;

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

        // Decide between incremental scroll update and full redraw.
        //
        // Incremental path: the offscreen canvas already contains the rendered
        // spectrogram for the previous bbStartCol. If the viewport only shifted
        // forward by a small number of columns (columnsShifted ≤ half the buffer),
        // we can self-blit the offscreen canvas to scroll it left and only render
        // the new right-edge columns — typically 1-2 per frame at 1× playback.
        // This reduces per-pixel work from O(bbWidth × height) to O(delta × height),
        // matching what any native scrolling spectrogram (e.g. Audacity) does.
        //
        // Fall back to full redraw on: first call, seek, zoom/tier change, resize,
        // or when new chunk data arrived (cacheVersion changed).
        const prevStartCol = prevBbStartColRef.current;
        const columnsShifted = prevStartCol !== null ? bbStartCol - prevStartCol : Infinity;
        const offscreenReady =
            offscreen.width === bbWidth && offscreen.height === canvas.height;
        const canIncremental =
            columnsShifted > 0 &&
            columnsShifted <= Math.floor(bbWidth / 2) &&
            offscreenReady &&
            cacheVersion === prevCacheVersionRef.current;

        if (offscreen.width !== bbWidth) offscreen.width = bbWidth;
        if (offscreen.height !== canvas.height) offscreen.height = canvas.height;
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;

        offCtx.imageSmoothingEnabled = false;

        if (canIncremental) {
          // ── Incremental path ────────────────────────────────────────────────
          // 1. Shift the offscreen canvas left by columnsShifted pixels.
          offCtx.drawImage(offscreen, -columnsShifted, 0);

          // 2. Build data for only the new right-edge columns.
          const newCols = columnsShifted;
          const newColStartAbs = bbEndCol - newCols;

          // Reuse grow-only buffers (rounded to 64-col buckets) instead of
          // allocating a Uint16Array/Uint8Array pair every frame.
          const ivNeeded = newCols * nFreqBins;
          if (incrVdBuf.current.length < ivNeeded) {
            incrVdBuf.current = new Uint16Array(Math.ceil(newCols / 64) * 64 * nFreqBins);
          } else {
            incrVdBuf.current.fill(0, 0, ivNeeded);
          }
          const vdNew = incrVdBuf.current.subarray(0, ivNeeded);

          if (incrCbBuf.current.length < newCols) {
            incrCbBuf.current = new Uint8Array(Math.ceil(newCols / 64) * 64);
          } else {
            incrCbBuf.current.fill(0, 0, newCols);
          }
          const cbNew = incrCbBuf.current.subarray(0, newCols);
          for (let i = 0; i < newCols; i++) {
            const absCol = newColStartAbs + i;
            if (absCol < 0) continue;
            const t = absCol / cps;
            if (t >= duration) continue;
            const result = chunkCache.getChunkWithFallback(t, activeTier.tier);
            if (!result) continue;
            const { chunk } = result;
            if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) continue;
            const chunkCps = chunk.nCols / chunk.actualDurationSec;
            let col = Math.round((t - chunk.startSec) * chunkCps);
            if (col < 0) col = 0;
            if (col >= chunk.nCols) col = chunk.nCols - 1;
            const bins = Math.min(nFreqBins, chunk.nFreqBins);
            vdNew.set(chunk.data.subarray(col * chunk.nFreqBins, col * chunk.nFreqBins + bins), i * nFreqBins);
            cbNew[i] = 1;
          }

          // 3. Render those new columns to a small fixed-width canvas and blit
          //    only the used portion onto the right edge of the offscreen canvas.
          //    Width is capped at 8 so the canvas is never resized during playback.
          const INCR_CANVAS_W = 8;
          if (!incrCanvasRef.current) incrCanvasRef.current = document.createElement('canvas');
          const incrCanvas = incrCanvasRef.current;
          if (incrCanvas.width !== INCR_CANVAS_W) incrCanvas.width = INCR_CANVAS_W;
          if (incrCanvas.height !== offscreen.height) incrCanvas.height = offscreen.height;
          const incrCtx = incrCanvas.getContext('2d');
          if (incrCtx) {
            drawSpectrogramChunk(
              incrCtx, vdNew, newCols, nFreqBins,
              newCols, offscreen.height,
              settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
              settings.displayFloor, settings.displayCeil,
              cbNew,
            );
            // Blit only the newCols-wide left portion of incrCanvas onto the right edge.
            offCtx.drawImage(incrCanvas, 0, 0, newCols, offscreen.height,
                             bbWidth - newCols, 0, newCols, offscreen.height);
          }
        } else {
          // ── Full redraw path ─────────────────────────────────────────────────
          // Reuse component-level buffers — grow-only, rounded to 64-col buckets.
          const vdNeeded = bbWidth * nFreqBins;
          if (viewportDataBuf.current.length < vdNeeded) {
            viewportDataBuf.current = new Uint16Array(Math.ceil(bbWidth / 64) * 64 * nFreqBins);
          } else {
            viewportDataBuf.current.fill(0, 0, vdNeeded);
          }
          const viewportData = viewportDataBuf.current.subarray(0, vdNeeded);

          if (colBuiltBuf.current.length < bbWidth) {
            colBuiltBuf.current = new Uint8Array(Math.ceil(bbWidth / 64) * 64);
          } else {
            colBuiltBuf.current.fill(0, 0, bbWidth);
          }
          const colBuilt = colBuiltBuf.current.subarray(0, bbWidth);

          for (let i = 0; i < bbWidth; i++) {
            const absCol = bbStartCol + i;
            if (absCol < 0) continue;
            const t = absCol / cps;
            if (t >= duration) continue;
            const result = chunkCache.getChunkWithFallback(t, activeTier.tier);
            if (!result) continue;
            const { chunk } = result;
            if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) continue;
            const chunkCps = chunk.nCols / chunk.actualDurationSec;
            let col = Math.round((t - chunk.startSec) * chunkCps);
            if (col < 0) col = 0;
            if (col >= chunk.nCols) col = chunk.nCols - 1;
            const bins = Math.min(nFreqBins, chunk.nFreqBins);
            const srcOffset = col * chunk.nFreqBins;
            const dstOffset = i * nFreqBins;
            viewportData.set(chunk.data.subarray(srcOffset, srcOffset + bins), dstOffset);
            colBuilt[i] = 1;
          }

          drawSpectrogramChunk(
            offCtx, viewportData, bbWidth, nFreqBins,
            offscreen.width, offscreen.height,
            settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
            settings.displayFloor, settings.displayCeil,
            colBuilt,
          );
        }

        prevBbStartColRef.current = bbStartCol;
        prevCacheVersionRef.current = cacheVersion;

        // Blit offscreen → visible canvas with sub-pixel destination shift.
        // dxPhys / dwPhys are in physical pixels (canvas.width is in physical px).
        const dxCss = (bbStartTime - startTime) * pixelsPerSecond;
        const dwCss = bbWidth / cps * pixelsPerSecond;
        const dwPhys = dwCss * dpr;
        const dxPhys = dxCss * dpr;

        // When cps >> pps the blit is a >1× downsample. Browser bilinear uses
        // only 2 taps regardless of the scale factor, so it skips source columns
        // and their weights shift frame-to-frame as dxPhys slides — the
        // "brightness shimmer". Fix: pre-shrink to near destination width in
        // ≤2× steps (each step bilinear is accurate at ≤2×) then do a ~1:1 blit.
        let blitSrc: HTMLCanvasElement = offscreen as unknown as HTMLCanvasElement;
        let blitW = bbWidth;
        const downsampleRatio = bbWidth / dwPhys;
        if (downsampleRatio > 1.5) {
          const targetW = Math.max(1, Math.round(dwPhys));
          if (!preshrinkCanvasRef.current) preshrinkCanvasRef.current = document.createElement('canvas');
          const tmp = preshrinkCanvasRef.current;
          if (tmp.width !== targetW) tmp.width = targetW;
          if (tmp.height !== offscreen.height) tmp.height = offscreen.height;
          const tmpCtx = tmp.getContext('2d');
          if (tmpCtx) {
            tmpCtx.imageSmoothingEnabled = true;
            tmpCtx.imageSmoothingQuality = 'high';
            tmpCtx.drawImage(offscreen, 0, 0, bbWidth, offscreen.height, 0, 0, targetW, offscreen.height);
            blitSrc = tmp;
            blitW = targetW;
          }
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(blitSrc, 0, 0, blitW, offscreen.height,
                      dxPhys, 0, dwPhys, canvas.height);

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

    // Reconcile the build-progress veil. Guarded by a ref so setState (and the
    // resulting re-render) only happens when the value actually flips — draw
    // runs every RAF, so an unconditional setState would loop forever.
    if (building !== isBuildingRef.current) {
      isBuildingRef.current = building;
      setIsBuilding(building);
    }
  }, [chunkCache, sampleRate, cacheVersion, scrollLeft, pixelsPerSecond, duration, settings.fftSize, settings.minFreq, settings.maxFreq, settings.frequencyScale, settings.displayFloor, settings.displayCeil, isProcessing, canvasRef, offscreenCanvasRef, setIsBuilding]);

  return { draw };
}
