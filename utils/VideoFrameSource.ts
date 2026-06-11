/**
 * VideoFrameSource — frame-perfect video playback via MP4Box.js + WebCodecs.
 *
 * ── Why ────────────────────────────────────────────────────────────────────────
 * The <video> element can't keep up with an external audio clock at the frame
 * level: seeking triggers keyframe decodes (slow) and playbackRate nudging
 * drifts. For ML label boundaries, users need to see the *exact* frame that
 * corresponds to the audio under the playhead.
 *
 * This class demuxes an MP4/MOV into encoded samples, feeds them to a
 * VideoDecoder, and caches the resulting VideoFrames keyed by microsecond
 * timestamp. A canvas rAF loop draws the newest cached frame at or before
 * the engine's current media time — no <video> element involved.
 *
 * ── Data flow ──────────────────────────────────────────────────────────────────
 *   asset bytes → MP4Box.js → VideoDecoder → VideoFrame cache → canvas.drawImage
 *
 * ── Critical implementation note: buffer lifecycle ─────────────────────────────
 * mp4box's appendBuffer() calls stream.cleanBuffers() before returning, destroying
 * the raw sample byte data. This means seek()+start() called *after* appendBuffer
 * returns will find getSample() returning null for every sample (no data).
 *
 * Solution: for each ensureRange() call, create a fresh ISOFile, re-append the
 * stored rawBuffer, and call seek()+start() from *inside* the onReady callback —
 * while appendBuffer is still on the stack and the stream data is live.
 * mp4box's processSamples loop is synchronous, so all onSamples batches fire
 * before appendBuffer returns and cleans the buffers.
 *
 * ── Invariants ─────────────────────────────────────────────────────────────────
 * - One VideoFrameSource per opened track.
 * - Frame cache is sorted ascending by timestamp (μs).
 * - drawAt is O(log N) and never stalls — if the exact frame isn't cached, we
 *   draw the nearest frame whose timestamp ≤ t.
 * - VideoFrame holds a GPU resource; .close() MUST be called on every evicted
 *   or superseded frame.
 *
 * ── Limitations ────────────────────────────────────────────────────────────────
 * - MP4/MOV (ISOBMFF) only. WebM/MKV/AVI require different demuxers.
 * - Whole-file load into memory. For >2 GB files we'd need to stream via range
 *   reads; not implemented.
 */

import { createFile, DataStream, Endianness, type ISOFile, type Sample, type Track, type MP4BoxBuffer } from 'mp4box';
import { DEFAULT_VIEWPORT, computeContentRect, drawLetterboxed, regionPx, type Viewport } from './videoZoom';
import { getExt } from '../constants';

const DEFAULT_WINDOW_BEFORE_SEC = 2;
const DEFAULT_WINDOW_AFTER_SEC = 30;
const MEMORY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
// WebCodecs timestamps are microseconds; this converts seconds ↔ µs.
const MICROS_PER_SEC = 1e6;

export interface VideoFrameSourceOptions {
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

export class VideoFrameSource {
  /** Raw file bytes retained for re-feeding fresh mp4box instances per ensureRange(). */
  private rawBuffer: ArrayBuffer | null = null;
  private trackId = 0;
  private trackTimescale = 0;
  private width = 0;
  private height = 0;
  /** Sample metadata (no byte data) — used for allCached checks and range math. */
  private samples: Sample[] = [];
  private decoder: VideoDecoder | null = null;
  /** Cached frames, sorted ascending by timestamp (μs). */
  private frameCache: VideoFrame[] = [];
  private opened = false;
  private closed = false;
  private currentPlayheadSec = 0;
  private activeRange: { start: number; end: number } | null = null;
  /** User's current selection — frames in this range are never evicted, even
   *  under memory pressure.  Set via pinSelectionRange(); cleared to null when
   *  the selection is cleared. Distinct from activeRange, which is overwritten
   *  by every ensureRange() call (including the rolling prefetch). */
  private pinnedRange: { start: number; end: number } | null = null;
  /** Bumped on every ensureRange() call; stale in-flight decode phases ignore
   *  their results when this no longer matches their captured token. */
  private rangeToken = 0;
  private approxCacheBytes = 0;
  private bytesPerFrame = 0;
  /** Current zoom/pan viewport applied by drawAt. Default = whole frame. */
  private viewport: Viewport = DEFAULT_VIEWPORT;
  /** When non-null, drawAt renders the frame nearest this time instead of the
   *  live playhead — used during paused seeks so intermediate GOP frames don't
   *  flash on the canvas before the target frame is decoded. */
  private frozenDisplaySec: number | null = null;
  private opts: VideoFrameSourceOptions;

  constructor(opts: VideoFrameSourceOptions = {}) {
    this.opts = opts;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Mark a range whose frames must never be evicted under memory pressure.
   *  Call this whenever the user sets/updates a selection; call
   *  clearPinnedRange() when the selection is cleared. */
  pinSelectionRange(startSec: number, endSec: number): void {
    this.pinnedRange = { start: startSec, end: endSec };
  }

  clearPinnedRange(): void {
    this.pinnedRange = null;
  }

  /** Freeze the displayed frame at `timeSec` (the position before a paused
   *  seek begins). drawAt still advances currentPlayheadSec for eviction math,
   *  but the canvas renders the frozen frame until clearDisplayFreeze() fires. */
  freezeDisplayAt(timeSec: number): void {
    this.frozenDisplaySec = timeSec;
  }

  clearDisplayFreeze(): void {
    this.frozenDisplaySec = null;
  }


  async open(assetUrl: string): Promise<{ width: number; height: number; durationSec: number }> {
    if (this.opened) throw new Error('VideoFrameSource already opened');
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder not supported in this environment');
    }

    const resp = await fetch(assetUrl);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
    this.rawBuffer = await resp.arrayBuffer();

    return new Promise((resolve, reject) => {
      const file = createFile();

      file.onError = (_module: string, msg: string) => {
        const err = new Error(`mp4box: ${msg}`);
        this.opts.onDebugLog?.(`[video] ${err.message}`, 'error');
        if (!this.opened) reject(err);
      };

      file.onReady = (info) => {
        try {
          const track = info.videoTracks[0];
          if (!track) throw new Error('no video track in file');
          this.trackId = track.id;
          this.trackTimescale = track.timescale;
          this.width = track.video?.width ?? track.track_width;
          this.height = track.video?.height ?? track.track_height;
          this.bytesPerFrame = this.width * this.height * 4;
          this.samples = file.getTrackSamplesInfo(track.id);

          const description = this.buildDecoderDescription(file, track);
          if (!description) throw new Error(`unsupported codec: ${track.codec}`);

          this.decoder = new VideoDecoder({
            output: (frame) => this.onDecodedFrame(frame),
            error: (e) => {
              this.opts.onDebugLog?.(`[video] decoder error: ${e.message}`, 'error');
            },
          });
          this.decoder.configure({
            codec: track.codec,
            description,
            codedWidth: this.width,
            codedHeight: this.height,
            optimizeForLatency: false,
          });

          this.opened = true;
          this.opts.onDebugLog?.(
            `[video] opened codec=${track.codec} size=${this.width}x${this.height} samples=${this.samples.length}`,
          );
          resolve({
            width: this.width,
            height: this.height,
            durationSec: track.duration / track.timescale,
          });
        } catch (err) {
          reject(err);
        }
      };

      const mp4buf = this.rawBuffer as MP4BoxBuffer;
      (mp4buf as unknown as { fileStart: number }).fileStart = 0;
      try {
        file.appendBuffer(mp4buf);
        // Do NOT call file.flush() here. flush() calls stream.cleanBuffers()
        // which would destroy the byte data needed by future ensureRange() calls.
        // appendBuffer itself also calls cleanBuffers() at the end, but we store
        // rawBuffer separately and re-append it in each ensureRange().
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Decode every frame whose timestamp falls in [startSec, endSec], starting
   *  from the nearest prior keyframe. Resolves when the decoder has flushed.
   *
   *  Implementation: creates a fresh ISOFile per call and appends rawBuffer.
   *  The key insight is that mp4box's processSamples loop runs synchronously
   *  within appendBuffer() before cleanBuffers() destroys the stream data.
   *  We call seek()+start() inside onReady so extraction happens while the
   *  data is still live. */
  async ensureRange(startSec: number, endSec: number, caller = 'unknown'): Promise<void> {
    if (!this.opened || !this.decoder || this.closed || !this.rawBuffer) return;
    if (endSec < startSec) return;

    const callToken = this.rangeToken; // snapshot before any bump
    this.opts.onDebugLog?.(
      `[ensureRange] caller=${caller} range=${startSec.toFixed(3)}-${endSec.toFixed(3)}s token-before=${callToken} cached=${this.frameCache.length}`,
    );

    this.activeRange = { start: startSec, end: endSec };

    const ts = this.trackTimescale;
    const startCts = startSec * ts;
    const endCts = endSec * ts;

    // Find the RAP at/before startSec and the last sample at/before endSec.
    let keyIdx = -1;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.cts > startCts) break;
      if (s.is_sync) keyIdx = i;
    }
    if (keyIdx === -1) keyIdx = 0;

    let endIdx = keyIdx;
    for (let i = keyIdx; i < this.samples.length; i++) {
      if (this.samples[i].cts > endCts) break;
      endIdx = i;
    }

    // Walk the candidate span to find which *display* frames are missing.
    // Samples are in DECODE order and, with B-frames (e.g. avc1 High profile),
    // cts is NOT monotonic in index — so test each sample's cts individually
    // rather than assuming a contiguous "visible" suffix. Frames whose cts is
    // outside [startCts, endCts] are decode scaffolding: they're fed to the
    // decoder for references but must NOT be required resident in the cache.
    // (An earlier version cut on a decode-order prefix; with B-frame reorder
    // that swept in pre-selection frames whose cts < startCts. Those sit just
    // below a pinned selection, get evicted, and forced a full-GOP re-decode on
    // every replay — the stutter this guards against.)
    let firstMissingIdx = -1;
    let lastMissingIdx = -1;
    for (let i = keyIdx; i <= endIdx; i++) {
      const cts = this.samples[i].cts;
      if (cts < startCts || cts > endCts) continue; // scaffolding, not required resident
      const tsMicros = Math.round((cts / ts) * MICROS_PER_SEC);
      if (!this.hasFrameAt(tsMicros)) {
        if (firstMissingIdx === -1) firstMissingIdx = i;
        lastMissingIdx = i;
      }
    }
    if (firstMissingIdx === -1) {
      // All visible frames cached — leave token alone so any in-flight decode
      // of an adjacent range isn't cancelled.
      this.opts.onDebugLog?.(
        `[ensureRange] caller=${caller} FAST-PATH all visible cached, token unchanged at ${this.rangeToken}`,
      );
      this.evictOutsideWindow();
      return;
    }

    // Narrow the decode to the smallest window that still produces the missing
    // frames.  Delta frames need their GOP's reference frames, so the decode
    // must start at the RAP at-or-before firstMissingIdx; the upper bound can
    // stop at lastMissingIdx, skipping already-cached trailing GOPs.
    let narrowKeyIdx = keyIdx;
    for (let i = firstMissingIdx; i >= 0; i--) {
      if (this.samples[i].is_sync) { narrowKeyIdx = i; break; }
    }
    keyIdx = narrowKeyIdx;
    endIdx = lastMissingIdx;
    // The feed now stops on decode-order sample number (endSampleNumber below),
    // so endCts is intentionally left at the requested range end and not
    // narrowed to endIdx's cts.

    // Only bump the token (cancelling any previous in-flight decode) when we
    // actually need to do work.
    const token = ++this.rangeToken;
    this.opts.onDebugLog?.(
      `[ensureRange] caller=${caller} TOKEN BUMP to ${token} (was ${token - 1}), missing=[${firstMissingIdx}..${lastMissingIdx}] of [${keyIdx}..${endIdx}]`,
    );

    const endSampleNumber = this.samples[endIdx].number;
    const wallStart = performance.now();
    this.opts.onDebugLog?.(
      `[video] ensureRange ${startSec.toFixed(2)}–${endSec.toFixed(2)}s samples [${keyIdx}..${endIdx}] (${endIdx - keyIdx + 1}) playhead=${this.currentPlayheadSec.toFixed(3)}s`,
    );

    let fed = 0;

    // Each ensureRange creates a fresh ISOFile and re-appends rawBuffer.
    // start() is called inside onReady — while appendBuffer is still on the
    // call stack — so getSample can find the stream bytes before cleanBuffers
    // runs. Everything in this block is synchronous within appendBuffer().
    await new Promise<void>((resolve, reject) => {
      const file = createFile();

      file.onError = (_module: string, msg: string) => {
        reject(new Error(`mp4box: ${msg}`));
      };

      file.onReady = (_info) => {
        if (token !== this.rangeToken || this.closed) return;

        // Large nbSamples so the whole range fits in one onSamples callback.
        file.setExtractionOptions(this.trackId, null, { nbSamples: 100000 });

        file.onSamples = (_id: number, _user: unknown, samples: Sample[]) => {
          if (token !== this.rangeToken || this.closed) { file.stop(); return; }
          for (const sample of samples) {
            // Stop strictly on decode-order sample number (below), never on cts.
            // Samples arrive in DECODE order; with B-frames a high-cts anchor
            // (e.g. the P-frame of an IBBP group) is decoded *before* the
            // lower-cts B-frames that reference it. Stopping when cts > endCts
            // would cut the feed off at that anchor and starve the in-range
            // B-frames that follow it in decode order — they'd never decode and
            // would be re-requested on every replay. Feeding the full
            // [keyIdx..endIdx] decode-order span is safe: H.264 guarantees a
            // frame's references all precede it in decode order.
            if (!sample.data) {
              this.opts.onDebugLog?.(`[video] sample ${sample.number} has no data`, 'error');
              continue;
            }
            if (this.decoder && this.decoder.state === 'configured') {
              try {
                this.decoder.decode(new EncodedVideoChunk({
                  type: sample.is_sync ? 'key' : 'delta',
                  timestamp: Math.round((sample.cts / sample.timescale) * MICROS_PER_SEC),
                  duration: Math.round((sample.duration / sample.timescale) * MICROS_PER_SEC),
                  data: sample.data,
                }));
                fed++;
              } catch (err) {
                this.opts.onDebugLog?.(
                  `[video] decode() threw on sample ${sample.number}: ${String(err)}`, 'error',
                );
              }
            }
            if (sample.number >= endSampleNumber) { file.stop(); return; }
          }
        };

        // Seek positions trak.nextSample at the RAP at/before startSec.
        // Must be called after setExtractionOptions so the extractedTrack
        // entry exists when processSamples starts.
        file.seek(startSec, true);
        // start() triggers the synchronous processSamples loop, which calls
        // onSamples before returning. Buffer data is still live here.
        file.start();
      };

      // Re-attach fileStart before each appendBuffer call.
      (this.rawBuffer as unknown as { fileStart: number }).fileStart = 0;
      try {
        file.appendBuffer(this.rawBuffer as MP4BoxBuffer);
        // appendBuffer has returned; onReady + onSamples have already fired
        // and decoder.decode() has been called fed times.
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    if (token !== this.rangeToken || this.closed) return;

    // decoder.decode() is async; flush() waits for all pending frames to arrive
    // via onDecodedFrame before resolving.
    const flushStart = performance.now();
    try {
      await this.decoder!.flush();
    } catch (err) {
      this.opts.onDebugLog?.(`[video] flush() threw: ${String(err)}`, 'error');
    }

    if (token !== this.rangeToken || this.closed) return;
    const flushMs = performance.now() - flushStart;
    const totalMs = performance.now() - wallStart;
    this.opts.onDebugLog?.(
      `[video] ensureRange done ${startSec.toFixed(2)}–${endSec.toFixed(2)}s: flush=${flushMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms fed=${fed} cached=${this.frameCache.length}`,
    );
    this.evictOutsideWindow();
  }

  /** Draw the cached frame nearest to (but not after) tSec into ctx. If no
   *  suitable frame is cached, we draw the earliest frame we have to avoid
   *  a blank canvas — better stale than empty. */
  drawAt(ctx: CanvasRenderingContext2D, tSec: number): void {
    this.currentPlayheadSec = tSec;
    const frame = this.currentFrame(this.frozenDisplaySec ?? undefined);
    if (!frame) return;

    const canvas = ctx.canvas;
    const frameW = frame.displayWidth || this.width;
    const frameH = frame.displayHeight || this.height;
    // The whole frame letterboxes into this display rect; the zoomed
    // sub-region maps into the *same* rect, so the picture stays put and
    // only the visible portion changes — keeping playhead/frame sync intact.
    const dst = computeContentRect(canvas.width, canvas.height, frameW, frameH);
    const src = regionPx(this.viewport, frameW, frameH);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Use clip + 5-arg drawImage (whole frame scaled) instead of 9-arg
    // source-rect cropping: WKWebView (Tauri/macOS) ignores the source
    // rectangle for VideoFrame sources, which would draw the full frame
    // unzoomed. Scaling the entire frame and clipping to dst is equivalent
    // and uses only the well-supported draw path.
    const scale = dst.w / src.w; // == dst.h / src.h (aspect preserved)
    const fullW = frameW * scale;
    const fullH = frameH * scale;
    const originX = dst.x - src.x * scale;
    const originY = dst.y - src.y * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.drawImage(frame, originX, originY, fullW, fullH);
    ctx.restore();
  }

  /** Update the zoom/pan viewport. Cheap — applied on the next rAF draw. */
  setViewport(vp: Viewport): void {
    this.viewport = vp;
  }

  /** Draw the *whole* current frame (ignoring the viewport) fitted into a
   *  w×h context — used by the minimap viewfinder. */
  drawThumbnail(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const frame = this.currentFrame();
    if (!frame) return;
    const frameW = frame.displayWidth || this.width;
    const frameH = frame.displayHeight || this.height;
    drawLetterboxed(ctx, frame, w, h, frameW, frameH);
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  getFrameDuration(): number {
    if (this.samples && this.samples.length > 0) {
      return this.samples[0].duration / this.trackTimescale;
    }
    return 1 / 30;
  }

  notifyPlayhead(tSec: number): void {
    this.currentPlayheadSec = tSec;
  }

  close(): void {
    this.closed = true;
    this.frozenDisplaySec = null;
    this.rangeToken++;
    for (const f of this.frameCache) {
      try { f.close(); } catch { /* already closed */ }
    }
    this.frameCache = [];
    this.approxCacheBytes = 0;
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch { /* already closed */ }
    }
    this.decoder = null;
    this.rawBuffer = null;
    this.samples = [];
    this.opened = false;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private buildDecoderDescription(file: ISOFile, track: Track): Uint8Array | undefined {
    const trak = file.moov?.traks?.find(
      (t) => (t.tkhd as unknown as { track_id: number })?.track_id === track.id,
    );
    const entries = (trak as unknown as {
      mdia?: { minf?: { stbl?: { stsd?: { entries?: unknown[] } } } };
    } | undefined)?.mdia?.minf?.stbl?.stsd?.entries;
    const entry = entries?.[0] as {
      avcC?: { write: (s: DataStream) => void };
      hvcC?: { write: (s: DataStream) => void };
      vpcC?: { write: (s: DataStream) => void };
      av1C?: { write: (s: DataStream) => void };
    } | undefined;
    const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
    if (!box) return undefined;

    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer.slice(8));
  }

  private onDecodedFrame(frame: VideoFrame): void {
    if (this.closed || frame.timestamp === null) {
      try { frame.close(); } catch { /* */ }
      return;
    }
    const ts = frame.timestamp;
    if (this.hasFrameAt(ts)) {
      try { frame.close(); } catch { /* */ }
      return;
    }
    let lo = 0;
    let hi = this.frameCache.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.frameCache[mid].timestamp ?? 0) < ts) lo = mid + 1;
      else hi = mid;
    }
    this.frameCache.splice(lo, 0, frame);
    this.approxCacheBytes += this.bytesPerFrame;

    if (this.approxCacheBytes > MEMORY_BUDGET_BYTES) {
      this.enforceMemoryBudget();
    }
  }

  private hasFrameAt(tsMicros: number): boolean {
    let lo = 0;
    let hi = this.frameCache.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.frameCache[mid].timestamp ?? 0;
      if (v === tsMicros) return true;
      if (v < tsMicros) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** The cached frame at/before `atSec` (defaults to currentPlayheadSec), or
   *  the earliest cached frame as a fallback. null only when cache is empty. */
  private currentFrame(atSec?: number): VideoFrame | null {
    if (this.frameCache.length === 0) return null;
    const t = (atSec ?? this.currentPlayheadSec) * MICROS_PER_SEC;
    const idx = this.findFrameIdxAtOrBefore(t);
    return idx >= 0 ? this.frameCache[idx] : this.frameCache[0];
  }

  private findFrameIdxAtOrBefore(tsMicros: number): number {
    let lo = 0;
    let hi = this.frameCache.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.frameCache[mid].timestamp ?? 0;
      if (v <= tsMicros) { result = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return result;
  }

  private evictOutsideWindow(): void {
    const keepBefore = (this.currentPlayheadSec - DEFAULT_WINDOW_BEFORE_SEC) * MICROS_PER_SEC;
    const keepAfter = (this.currentPlayheadSec + DEFAULT_WINDOW_AFTER_SEC) * MICROS_PER_SEC;
    const selStart = this.activeRange ? this.activeRange.start * MICROS_PER_SEC : Infinity;
    const selEnd = this.activeRange ? this.activeRange.end * MICROS_PER_SEC : -Infinity;
    const pinnedStart = this.pinnedRange ? this.pinnedRange.start * MICROS_PER_SEC : Infinity;
    const pinnedEnd   = this.pinnedRange ? this.pinnedRange.end   * MICROS_PER_SEC : -Infinity;

    const kept: VideoFrame[] = [];
    for (const f of this.frameCache) {
      const t = f.timestamp ?? 0;
      const inPlayWindow = t >= keepBefore && t <= keepAfter;
      const inSel = t >= selStart && t <= selEnd;
      const inPinned = t >= pinnedStart && t <= pinnedEnd;
      if (inPlayWindow || inSel || inPinned) {
        kept.push(f);
      } else {
        try { f.close(); } catch { /* */ }
        this.approxCacheBytes -= this.bytesPerFrame;
      }
    }
    this.frameCache = kept;
    if (this.approxCacheBytes < 0) this.approxCacheBytes = 0;
  }

  private enforceMemoryBudget(): void {
    const playMicros = this.currentPlayheadSec * MICROS_PER_SEC;
    const pinnedStartMicros = this.pinnedRange ? this.pinnedRange.start * MICROS_PER_SEC : -Infinity;
    const pinnedEndMicros   = this.pinnedRange ? this.pinnedRange.end   * MICROS_PER_SEC : -Infinity;
    // Evict past frames first (already played, safe to drop), then future frames
    // only if we must. Pinned selection frames are never evicted — without this
    // guard the rolling prefetch (which decodes from a distant keyframe on
    // long-GOP videos) fills the cache and evicts the selection frames on every
    // loop.
    //
    // Sort key (ascending = evicted first):
    //   Past frames  (ts < playMicros): key = ts            → small positive, oldest = smallest
    //   Future frames (ts >= playMicros): key = MAX_SAFE_INT − ts  → very large, farthest = smallest within group
    // Past keys (~0..playMicros) are always much smaller than future keys (~MAX_SAFE_INT) so past
    // frames are always evicted before future frames.
    const sortKey = (ts: number): number =>
      ts < playMicros ? ts : Number.MAX_SAFE_INTEGER - ts;
    const idxByEvictPriority = this.frameCache
      .map((f, i) => ({ i, key: sortKey(f.timestamp ?? 0) }))
      .sort((a, b) => a.key - b.key);  // ascending: lowest key evicted first
    const drop = new Set<number>();
    let i = 0;
    while (this.approxCacheBytes > MEMORY_BUDGET_BYTES && i < idxByEvictPriority.length) {
      const frameTs = this.frameCache[idxByEvictPriority[i].i].timestamp ?? 0;
      if (frameTs >= pinnedStartMicros && frameTs <= pinnedEndMicros) {
        i++;
        continue; // never evict pinned selection frames
      }
      drop.add(idxByEvictPriority[i].i);
      this.approxCacheBytes -= this.bytesPerFrame;
      i++;
    }
    if (drop.size === 0) return;
    const kept: VideoFrame[] = [];
    for (let j = 0; j < this.frameCache.length; j++) {
      const f = this.frameCache[j];
      if (drop.has(j)) {
        try { f.close(); } catch { /* */ }
      } else {
        kept.push(f);
      }
    }
    this.frameCache = kept;
  }
}

/** Rough detection: only ISOBMFF containers (MP4/MOV/m4v) can be demuxed by
 *  mp4box.js. Other extensions fall back to the <video> element. */
export function canUseFrameSource(path: string): boolean {
  if (typeof VideoDecoder === 'undefined') return false;
  const ext = getExt(path);
  return ext === 'mp4' || ext === 'mov' || ext === 'm4v';
}
