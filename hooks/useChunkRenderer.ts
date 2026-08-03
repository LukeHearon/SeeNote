import React, { useCallback, useRef } from 'react';
import { SpectrogramSettings } from '../types';
import { drawSpectrogramChunk, sampleChunkColumnInto } from '../utils/audioProcessing';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { resolveRenderCps } from '../utils/viewportTransform';
import { Timeline, sourceRangesForDisplayRange } from '../utils/subsetTimeline';

// TEMP DIAGNOSTIC — logs over-budget frames and attributes heavy full redraws so
// we can tell a real playback hitch (dropped frame) from the sampling twinkle.
// Set to false to silence. See local/HITCH.md.
export const DIAG_FRAME_TIMING = false;


export interface ChunkRendererParams {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  // Read live from a ref (not a prop) so `draw` doesn't recreate on every scroll
  // step. During playback scrollLeft updates ~50 Hz via React state; depending on
  // it here would throttle the background redraw to that cadence and make the
  // spectrogram stutter at high playback rates. See local/HITCH.md.
  scrollLeftRef: React.MutableRefObject<number>;
  // Read live from a ref for the same reason as scrollLeftRef, and it must be
  // the SAME ref the zoom actions write synchronously: scroll and zoom are
  // applied together, so reading one live and the other from a prop pairs a new
  // scroll offset with the previous zoom for the frames before React commits.
  // That resolves to an unrelated region of the file (startTime = scroll / pps)
  // and flashed on screen on every zoom step.
  pixelsPerSecondRef: React.MutableRefObject<number>;
  // Same value as the ref, taken as a prop purely so `draw` is recreated and the
  // dirty flag set when the zoom genuinely changes.
  pixelsPerSecond: number;
  // DISPLAY duration and the display->source map. Every column below is placed
  // by display time and its data looked up by source time; with no subset the
  // timeline is the identity and the two are the same number, so this path is
  // unchanged from before.
  duration: number;
  timeline: Timeline;
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
  scrollLeftRef,
  pixelsPerSecondRef,
  pixelsPerSecond: pixelsPerSecondProp,
  duration,
  timeline,
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
  // Identity of the cache the offscreen buffer was last built from. When the cache
  // changes (track switch, FFT rebuild) the offscreen still holds the *previous*
  // track's pixels; without this guard the incremental path would shift/re-blit
  // those stale pixels instead of fully redrawing the new track.
  const prevChunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const prevDisplayFloorRef = useRef(settings.displayFloor);
  const prevDisplayCeilRef = useRef(settings.displayCeil);
  // Colormap-mapping settings: a change repaints every column (new freq remap or
  // colormap), so it forces a one-frame full redraw like floor/ceil.
  const prevMinFreqRef = useRef(settings.minFreq);
  const prevMaxFreqRef = useRef(settings.maxFreq);
  const prevFreqScaleRef = useRef(settings.frequencyScale);
  // colsPerSec the offscreen grid was last built at. A tier change (zoom) remaps
  // every column, so it can't go incremental even if the buffer size coincides.
  const prevCpsRef = useRef<number>(-1);
  // cacheVersion the interior dirty-fill last ran against. A bump means chunk data
  // arrived, so the scan must run even on the frame the viewport finishes resolving
  // (the chunk that completes it is the one that needs painting).
  const prevScanCacheVersionRef = useRef<number>(-1);
  // Per-column tier record of the CURRENT offscreen buffer (length tracks bbWidth):
  // 0 = column not painted (background), otherwise tier+1 of the chunk it was last
  // painted from. Travels with the buffer — shifted in lockstep with the self-blit.
  // Lets the incremental path repaint ONLY columns whose data arrived or resolved to
  // a finer tier since last frame, instead of full-redrawing the whole buffer while
  // the viewport is still building. Doubles as drawSpectrogramChunk's colMask
  // (which treats 0 as unbuilt/transparent).
  const offTierRef = useRef<Uint8Array>(new Uint8Array(0));
  // Tiny canvas for rendering 1-2 new columns per frame in the incremental path.
  const incrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // True while the visible viewport still has chunks resolving (first load or a
  // settings-driven rebuild). Drives the "building spectrogram" veil. Computed
  // inside `draw` (which already knows the active tier and iterates columns) and
  // mirrored into a ref so setState only fires on an actual transition — never
  // every frame, which would loop draw→render→draw.
  const isBuildingRef = useRef(false);

  // Main canvas: draws spectrogram data only.
  const draw = useCallback(() => {
    const t0 = DIAG_FRAME_TIMING ? performance.now() : 0;
    const canvas = canvasRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!canvas || !offscreen) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.width / dpr;   // canvas.width is now in physical px (see resize)

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Read scroll and zoom live from their refs so this redraw can run every rAF
    // frame during playback rather than being gated by the React state cycle.
    // Both come from refs so the pair is always from the same zoom level.
    const scrollLeft = scrollLeftRef.current;
    const pixelsPerSecond = pixelsPerSecondRef.current || pixelsPerSecondProp;
    const startTime = scrollLeft / pixelsPerSecond;
    const endTime = startTime + cssWidth / pixelsPerSecond;

    // Recomputed below: true while the visible range is still being built.
    let building = false;

    if (chunkCache && duration > 0) {
        // ── Two-stage spectrogram rendering pipeline ────────────────────────
        // Stage 1 (THIS BLOCK): build a viewport buffer at exactly one column
        // per PHYSICAL pixel and render it into an offscreen canvas. The
        // bridge between the active tier's own column rate and this pixel grid
        // happens here, in the data domain (fillColumn → sampleChunkColumnInto),
        // anchored to absolute column indices so each column's bytes are a pure
        // function of file time.
        //
        // Stage 2: a 1:1 drawImage of the offscreen canvas at a fractional
        // (sub-pixel) destination offset. Because the scale is exactly 1:1,
        // the bilinear pass only blends immediate neighbour columns — smooth
        // scrolling with no moire. Any RESCALE here instead beats against the
        // pixel grid and reads as crawling bands / flicker during playback.
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
        // What's on screen may be several disjoint stretches of the file (one
        // per subset span), so the cache is asked for each of them rather than
        // for the span between the first and the last — which under a sparse
        // subset would be most of the recording.
        // They go in as ONE prefetch: each call replaces the fetch queue, so
        // asking range by range had every span but the last cancel the one
        // before it.
        const srcRanges = sourceRangesForDisplayRange(timeline, startTime, endTime);
        chunkCache.prefetchRanges(srcRanges, activeTier.tier);

        // "Building" = the visible range isn't yet fully resolved at the active
        // tier (so columns are missing or drawn blurry from a coarser fallback),
        // with in-flight fetches as a corroborating signal. Both probes are
        // read-only — they never mutate tier hysteresis or LRU order.
        const allResolved = chunkCache.isViewportResolvedForRanges(srcRanges, activeTier.tier);
        building = !allResolved && chunkCache.pendingCount() > 0;

        // Probe one chunk for nFreqBins (same as before).
        let nFreqBins = settings.fftSize / 2;
        {
          const probe = chunkCache.getChunkWithFallback(timeline.toSource(startTime), activeTier.tier);
          if (probe) nFreqBins = probe.chunk.nFreqBins;
        }

        // The offscreen-canvas grid's column rate: one column per physical
        // pixel, whatever the active tier's own colsPerSec is. Chunk data finer
        // than the pixel grid is area-averaged into each column and coarser
        // data interpolated (fillColumn below), so stage 2 never rescales.
        // Also keeps the buffer proportional to the window, not the file.
        // See resolveRenderCps.
        const cps = resolveRenderCps(pixelsPerSecond, dpr);

        // Compute the offscreen backbuffer extent. One offscreen pixel per STFT
        // column at the active tier. Add 1-col margin on the left so sub-pixel
        // drawImage shift never reads past the buffer.
        const bbStartCol = Math.floor(startTime * cps) - 1;
        // Width is a STABLE column span derived from the (fixed-per-zoom) visible
        // duration, not from ceil(endTime*cps). The latter wobbles between N and
        // N+1 as startTime slides sub-column, which resized the offscreen every
        // other frame and forced a full redraw (the `resize` stutter). A constant
        // span keeps the buffer the same size frame-to-frame so the incremental
        // path stays engaged. +3 columns of margin covers the sub-column slop on
        // both edges plus the left margin above.
        const visibleDurationSec = cssWidth / pixelsPerSecond;
        const bbWidth = Math.max(1, Math.ceil(visibleDurationSec * cps) + 3);
        const bbEndCol = bbStartCol + bbWidth;
        const bbStartTime = bbStartCol / cps;

        // Fill one offscreen column's freq-bin data from the cache. `absCol` is
        // the column's absolute index on the cps grid, so everything below is a
        // pure function of file time — the same absolute column always yields
        // the same bytes wherever the viewport sits. Any viewport-phase
        // dependence here becomes per-frame twinkle on screen. Returns the tier
        // byte (tier+1, 0 = no data) for offTier / drawSpectrogramChunk's
        // colMask. Shared by the incremental and full-redraw paths so the
        // sampling math lives in exactly one place.
        const fillColumn = (absCol: number, dst: Uint16Array, dstOffset: number): number => {
          if (absCol < 0) return 0;
          const dispT = absCol / cps;
          if (dispT >= duration) return 0;
          const t = timeline.toSource(dispT);
          const result = chunkCache.getChunkWithFallback(t, activeTier.tier);
          if (!result) return 0;
          const { chunk } = result;
          if (chunk.nCols === 0 || chunk.actualDurationSec <= 0) return 0;
          const chunkCps = chunk.nCols / chunk.actualDurationSec;
          // The column covers [dispT, dispT + 1/cps) — one physical pixel of
          // time; source rate equals display rate within a subset span, so the
          // window is the same width in the chunk's coordinates.
          const pos = (t - chunk.startSec) * chunkCps;
          sampleChunkColumnInto(
            dst, dstOffset, Math.min(nFreqBins, chunk.nFreqBins),
            chunk.data, chunk.nFreqBins, chunk.nCols,
            pos, pos + chunkCps / cps,
          );
          return result.tier + 1;
        };

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
        // Any colormap-mapping setting change (dBFS level→color range, frequency
        // bounds, or frequency scale) repaints every column, so force a one-frame
        // full redraw — the incremental path would otherwise leave interior columns
        // rendered with the old mapping while only the edge picked up the new one.
        if (settings.displayFloor !== prevDisplayFloorRef.current ||
            settings.displayCeil !== prevDisplayCeilRef.current ||
            settings.minFreq !== prevMinFreqRef.current ||
            settings.maxFreq !== prevMaxFreqRef.current ||
            settings.frequencyScale !== prevFreqScaleRef.current) {
          prevBbStartColRef.current = null;
          prevDisplayFloorRef.current = settings.displayFloor;
          prevDisplayCeilRef.current = settings.displayCeil;
          prevMinFreqRef.current = settings.minFreq;
          prevMaxFreqRef.current = settings.maxFreq;
          prevFreqScaleRef.current = settings.frequencyScale;
        }

        // A new cache (track switch / FFT rebuild) means the offscreen buffer holds
        // the previous track's pixels. Force a full redraw so the new track paints
        // from scratch rather than the incremental path scrolling stale content in.
        if (chunkCache !== prevChunkCacheRef.current) {
          prevChunkCacheRef.current = chunkCache;
          prevBbStartColRef.current = null;
        }

        const prevStartCol = prevBbStartColRef.current;
        const columnsShifted = prevStartCol !== null ? bbStartCol - prevStartCol : Infinity;
        const offscreenReady =
            offscreen.width === bbWidth && offscreen.height === canvas.height;
        // columnsShifted === 0 is the common steady-playback case: the view moved
        // forward by less than one whole column since last frame, so the offscreen
        // buffer is still exactly correct and we only need to re-blit it with the
        // updated sub-pixel offset — no rebuild, no shift. Allowing it here (>= 0)
        // re-blits the already-correct buffer instead of falling through to a full
        // redraw every such frame (~80% of playback frames) — the stutter fix.
        //
        // The incremental path self-blits the buffer and then only TOUCHES columns
        // that changed: the newly-exposed right edge, plus any interior columns whose
        // data arrived (or resolved to a finer tier) since last frame — tracked via
        // offTier. So it stays correct while the viewport is still building; it does
        // NOT need a full redraw just because data is streaming in. It falls back to
        // full redraw only on genuine geometry changes that remap every column.
        const viewportResolved = allResolved;
        const cpsChanged = prevCpsRef.current !== cps;
        // Whether chunk data arrived since the dirty-fill last ran. Lets the scan run
        // on the frame the viewport completes (when viewportResolved has already
        // flipped true) and skip entirely once resolved and idle.
        const dataChanged = cacheVersion !== prevScanCacheVersionRef.current;
        // Cap the incremental shift at half the buffer. The path's saving is
        // O(touched cols × height) vs the full O(bbWidth×height); once the shift
        // exceeds ~half the buffer most columns are new anyway, so the self-blit
        // (which discards everything left of the shift) stops paying for itself and a
        // full redraw is the same cost. The scratch canvas that renders the new
        // columns grows to fit newCols, so any shift up to this cap is painted right.
        const maxIncrCols = Math.floor(bbWidth / 2);
        const canIncremental =
            columnsShifted >= 0 &&
            columnsShifted <= maxIncrCols &&
            offscreenReady &&
            !cpsChanged;

        if (DIAG_FRAME_TIMING && prevStartCol !== null && !canIncremental) {
          const why =
            columnsShifted < 0 ? `back-step(${columnsShifted}col)`
            : columnsShifted > maxIncrCols ? `big-jump(${columnsShifted}col)`
            : !offscreenReady ? 'resize'
            : cpsChanged ? 'tier-change(cps)'
            : '?';
          // eslint-disable-next-line no-console
          console.warn(`[frametiming] FULL redraw of ${bbWidth} cols — ${why}`);
        }

        if (offscreen.width !== bbWidth) offscreen.width = bbWidth;
        if (offscreen.height !== canvas.height) offscreen.height = canvas.height;
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;

        offCtx.imageSmoothingEnabled = false;

        // Per-column tier record for the current buffer (0 = unpainted, else tier+1).
        // Grown to bbWidth; the full-redraw path rewrites it wholesale, the
        // incremental path keeps it in sync as it shifts and repaints.
        if (offTierRef.current.length < bbWidth) {
          offTierRef.current = new Uint8Array(Math.ceil(bbWidth / 64) * 64);
        }
        const offTier = offTierRef.current;

        // Paint a contiguous run of offscreen columns [destStartCol, +count) from
        // current cache state: build their column data, colormap them on the
        // grow-only scratch canvas, clear the destination strip (so columns with no
        // data read as background rather than stale pixels) and blit. Records each
        // column's source tier (tier+1, or 0 if no data) into offTier. Shared by the
        // new-edge render and the interior dirty-fill so the column-sampling math
        // lives in exactly one place.
        const paintColumns = (destStartCol: number, count: number) => {
          if (count <= 0) return;
          const ivNeeded = count * nFreqBins;
          if (incrVdBuf.current.length < ivNeeded) {
            incrVdBuf.current = new Uint16Array(Math.ceil(count / 64) * 64 * nFreqBins);
          } else {
            incrVdBuf.current.fill(0, 0, ivNeeded);
          }
          const vd = incrVdBuf.current.subarray(0, ivNeeded);
          if (incrCbBuf.current.length < count) {
            incrCbBuf.current = new Uint8Array(Math.ceil(count / 64) * 64);
          } else {
            incrCbBuf.current.fill(0, 0, count);
          }
          const cb = incrCbBuf.current.subarray(0, count);
          for (let i = 0; i < count; i++) {
            cb[i] = fillColumn(bbStartCol + destStartCol + i, vd, i * nFreqBins);
          }
          if (!incrCanvasRef.current) incrCanvasRef.current = document.createElement('canvas');
          const incrCanvas = incrCanvasRef.current;
          // Grow-only, rounded to 64-col buckets, so it never resizes (and clears)
          // during steady playback where count is 1-2.
          const wantW = Math.ceil(count / 64) * 64;
          if (incrCanvas.width < wantW) incrCanvas.width = wantW;
          if (incrCanvas.height !== offscreen.height) incrCanvas.height = offscreen.height;
          const incrCtx = incrCanvas.getContext('2d');
          if (!incrCtx) return;
          drawSpectrogramChunk(
            incrCtx, vd, count, nFreqBins,
            count, offscreen.height,
            settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
            settings.displayFloor, settings.displayCeil,
            cb,
          );
          offCtx.clearRect(destStartCol, 0, count, offscreen.height);
          offCtx.drawImage(incrCanvas, 0, 0, count, offscreen.height,
                           destStartCol, 0, count, offscreen.height);
          for (let i = 0; i < count; i++) offTier[destStartCol + i] = cb[i];
        };

        if (canIncremental) {
          // ── Incremental path ────────────────────────────────────────────────
          // 1. Shift the offscreen buffer (and its tier record) left by
          //    columnsShifted, then repaint only the newly-exposed right edge.
          //    columnsShifted === 0 (sub-column steady-playback move) skips both —
          //    the buffer is already correct and only the sub-pixel re-blit changes.
          if (columnsShifted > 0) {
            offCtx.drawImage(offscreen, -columnsShifted, 0);
            offTier.copyWithin(0, columnsShifted, bbWidth);
            offTier.fill(0, bbWidth - columnsShifted, bbWidth);
            // The self-blit composites source-over, so source columns that carry
            // no data (fully transparent) leave the destination's PREVIOUS pixels
            // untouched instead of clearing them. Scrolling into a not-yet-fetched
            // region therefore smears already-rendered content across it, which
            // reads as duplicated chunks. offTier already records which columns
            // should be blank, so clear those runs explicitly after the shift.
            const shiftedWidth = bbWidth - columnsShifted;
            let blankStart = -1;
            for (let i = 0; i <= shiftedWidth; i++) {
              const blank = i < shiftedWidth && offTier[i] === 0;
              if (blank) {
                if (blankStart === -1) blankStart = i;
              } else if (blankStart !== -1) {
                offCtx.clearRect(blankStart, 0, i - blankStart, offscreen.height);
                blankStart = -1;
              }
            }
            paintColumns(shiftedWidth, columnsShifted);
          }

          // 2. Repaint interior columns whose data changed since last frame — newly
          //    arrived (0 → built) or resolved to a finer tier. This is what lets the
          //    incremental path stay engaged while the viewport is still building:
          //    per-column work proportional to what actually changed, not a whole-
          //    buffer redraw every frame. Skipped once the viewport is fully resolved
          //    (nothing left to fill or upgrade), so steady playback pays only the
          //    edge render + re-blit. Columns are grouped into contiguous runs so each
          //    paint covers a span rather than one column at a time.
          if (!viewportResolved || dataChanged) {
            let runStart = -1;
            for (let i = 0; i <= bbWidth; i++) {
              let dirty = false;
              if (i < bbWidth) {
                const absCol = bbStartCol + i;
                let bestTier1 = 0;
                if (absCol >= 0) {
                  const dispT = absCol / cps;
                  if (dispT < duration) {
                    const r = chunkCache.getChunkWithFallback(timeline.toSource(dispT), activeTier.tier);
                    if (r) bestTier1 = r.tier + 1;
                  }
                }
                dirty = bestTier1 !== offTier[i];
              }
              if (dirty) {
                if (runStart === -1) runStart = i;
              } else if (runStart !== -1) {
                paintColumns(runStart, i - runStart);
                runStart = -1;
              }
            }
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
            colBuilt[i] = fillColumn(bbStartCol + i, viewportData, i * nFreqBins);
          }

          drawSpectrogramChunk(
            offCtx, viewportData, bbWidth, nFreqBins,
            offscreen.width, offscreen.height,
            settings.minFreq, settings.maxFreq, sampleRate, settings.frequencyScale,
            settings.displayFloor, settings.displayCeil,
            colBuilt,
          );
          // Sync the persistent tier record to what was just painted.
          offTier.set(colBuilt);
        }

        prevBbStartColRef.current = bbStartCol;
        prevCpsRef.current = cps;
        prevScanCacheVersionRef.current = cacheVersion;

        // Blit offscreen → visible canvas with a sub-pixel destination offset.
        // The buffer is one column per physical pixel (cps === pps·dpr), so
        // the scale is exactly 1:1: the browser's bilinear only ever blends
        // each column with its immediate neighbour by the fractional phase.
        // That is what makes the scroll smooth AND stable — a non-unit ratio
        // here beats against the pixel grid (crawling moire, flicker), and
        // integer-snapping the offset instead makes low scroll rates visibly
        // steppy and mid rates juddery. The residual artifact is fundamental
        // and mild: a feature exactly one pixel wide dims slightly while it
        // straddles two pixels mid-crossing.
        const dxPhys = (bbStartTime - startTime) * pixelsPerSecond * dpr;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(offscreen, 0, 0, bbWidth, offscreen.height,
                      dxPhys, 0, bbWidth, canvas.height);

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

    if (DIAG_FRAME_TIMING) {
      const dur = performance.now() - t0;
      // 8ms = half a 60fps frame budget; a draw this heavy risks a dropped frame.
      if (dur > 8) {
        // eslint-disable-next-line no-console
        console.warn(`[frametiming] draw ${dur.toFixed(1)}ms`);
      }
    }
  }, [chunkCache, sampleRate, cacheVersion, scrollLeftRef, pixelsPerSecondRef, pixelsPerSecondProp, duration, timeline, settings.fftSize, settings.minFreq, settings.maxFreq, settings.frequencyScale, settings.displayFloor, settings.displayCeil, isProcessing, canvasRef, offscreenCanvasRef, setIsBuilding]);

  return { draw };
}
