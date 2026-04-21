/**
 * AudioEngine — sample-accurate playback via scheduled AudioBufferSourceNodes
 *
 * ── Time model ────────────────────────────────────────────────────────────────
 *   ctxTime        = audioCtx.currentTime          (monotonic real-audio clock)
 *   playStartCtx   = ctxTime when .start(when) was called for the first sample
 *   playStartMedia = file position (seconds) of that first sample
 *   mediaTime(now) = playStartMedia + (ctxTime - playStartCtx)
 *
 * While paused, getMediaTime() returns the last known position. While buffering
 * before the scheduled start, the playhead is parked at playStartMedia.
 *
 * ── Priority invariants ───────────────────────────────────────────────────────
 * 1. Audio heard = samples under the playhead, bit-exactly.
 * 2. Selection playback starts and ends at exactly the requested sample.
 * 3. Playhead is slave to the audio clock — never advances ahead of emitted audio.
 * 4. Compressed formats (MP3/AAC/m4a/ogg/opus) behave identically to WAV.
 * 5. Days-long files work: sliding PCM window, not full-file load.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 * play() opens a Rust PcmStream starting just before startSec. An async
 * _prefetchLoop() continuously fetches 1s PCM chunks from Rust and schedules
 * them as AudioBufferSourceNodes. The loop keeps HORIZON_SEC of audio buffered
 * ahead of the current play position, sleeping when the buffer is full.
 *
 * play(startSec, endSec) schedules source.stop() at the exact context time
 * corresponding to endSec, enabling sample-accurate selection playback.
 */

import { getFileInfo, startPcmStream, readPcmChunk, closePcmStream } from './tauriCommands';

export interface AudioEngineCallbacks {
  /** Called on every animation frame during playback with the current media time. */
  onTimeUpdate: (mediaTime: number) => void;
  /** Called once when the first sample is actually emitted by the audio hardware. */
  onPlaying: () => void;
  onPaused: () => void;
  /** Called when playback reaches natural EOF (or endSec). Not called on pause/seek. */
  onEnded: () => void;
  /** Called when audio decoding can't keep up and there's a gap. */
  onBufferUnderrun: () => void;
  /** Optional: emitted for notable engine events (opens, errors, watchdog trips, etc.). */
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * How long play() is allowed to wait for the first PCM chunk to arrive before
 * we assume the decode path is stuck and abort. This is a safety valve for
 * codecs that open fine but then never deliver samples (e.g. hung format
 * readers). Without it the UI sits in "buffering" forever with no way for the
 * user to try another file.
 */
const STUCK_PLAY_TIMEOUT_MS = 3000;

/** Metadata for one scheduled AudioBufferSourceNode. */
interface ScheduledNode {
  source: AudioBufferSourceNode;
  mediaStart: number;
  mediaEnd: number;
  ctxStart: number;
  ctxEnd: number;
}

/** Cached decoded PCM for a range, keyed by (filePath, startSec, endSec). */
interface PcmCacheEntry {
  /** Deinterleaved channel data — index by channel, then frame. */
  channels: Float32Array[];
  totalFrames: number;
  startSec: number;
  endSec: number;
}

/** A subrange of a cache entry — what to actually play on a cache hit. */
interface PcmCacheSlice {
  entry: PcmCacheEntry;
  /** First frame to play, as an offset into the entry's channels. */
  startFrame: number;
  frameCount: number;
  /** Media time of the first frame (what we tell the playhead). */
  startSec: number;
  endSec: number;
}

/** How many frames to fetch per IPC call (~1 second of audio). */
const CHUNK_FRAMES_SEC = 1.0;
/** How many seconds of audio to keep scheduled ahead of the play position. */
const HORIZON_SEC = 4.0;
/** How long to sleep (ms) when the buffer is full before checking again. */
const SLEEP_MS = 250;
/** Minimum future-scheduling margin (seconds) required for `source.start(when)`
 *  to be sample-accurate rather than falling back to "ASAP" mode. Covers one
 *  render quantum (~3ms) plus a small safety buffer. Used in two places:
 *  - Cache hit: PCM is already in memory, so this is the full delay.
 *  - Uncached: applied AFTER the first chunk arrives from Rust (dynamic anchor),
 *    so we never block on a fixed IPC budget — we start as soon as samples are
 *    ready, with just enough lead time to schedule precisely. */
const START_MARGIN_SEC = 0.005;
/** Maximum number of preloaded regions to keep in the PCM replay cache. */
const MAX_PCM_CACHE_ENTRIES = 8;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  // Gain value applied at next gainNode creation (set via setGain before play)
  private _currentGain = 1;

  private filePath: string | null = null;
  private fileSampleRate = 44100;
  private fileChannels = 1;
  private fileDurationSec = 0;

  // ── Playback state ──────────────────────────────────────────────────────────
  // `playId` is incremented on every play() / _cancelPlayback(). Async
  // functions capture the current id and bail out if it no longer matches.
  private playId = 0;
  private isPlayingState = false;   // true once first sample emitted
  private onPlayingFired = false;   // guard so onPlaying fires exactly once
  private pausedAt = 0;             // last known media position while paused
  private playStartCtx = 0;        // ctx time of first scheduled sample (valid iff playStartCtxSet)
  private playStartCtxSet = false; // false while waiting for first chunk (or on cache hit, until set)
  private playStartMedia = 0;      // media time of first scheduled sample
  private endSec: number | null = null;

  // Scheduled nodes that haven't finished yet
  private queue: ScheduledNode[] = [];
  // Media cursor of the next byte the prefetch loop needs to schedule
  private schedCursor = 0;
  // Active Rust stream ID (null when not streaming)
  private streamId: number | null = null;

  private rafHandle: number | null = null;
  /** Number of PCM chunks successfully scheduled in the current play(). Used by
   *  the stuck-play watchdog to detect decodes that open but never deliver. */
  private chunksScheduled = 0;
  private stuckWatchdog: ReturnType<typeof setTimeout> | null = null;

  private callbacks: AudioEngineCallbacks;

  // ── PCM replay cache ────────────────────────────────────────────────────────
  // Decoded PCM for preloaded regions. On a cache hit, play() bypasses all
  // Rust IPC and schedules directly from the stored Float32Arrays.
  // Keyed by "filePath:startSec:endSec" (6 decimal places each).
  private _pcmCache = new Map<string, PcmCacheEntry>();
  private _pcmCacheOrder: string[] = [];  // front = LRU (oldest)
  /** Incremented on every preloadRange()/loadFile()/dispose(); stale preload loops exit. */
  private preloadId = 0;

  private _log(msg: string, type: 'info' | 'error' = 'info'): void {
    this.callbacks.onDebugLog?.(`[audio] ${msg}`, type);
  }

  constructor(callbacks: AudioEngineCallbacks) {
    this.callbacks = callbacks;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Prepare the engine for a new file. Fetches metadata and stores it.
   * Does NOT create an AudioContext here — that happens in play() so it is
   * always created during a user gesture (WKWebView/Safari require this to
   * start the context in 'running' state rather than 'suspended').
   */
  async loadFile(
    path: string,
  ): Promise<{ sampleRate: number; channels: number; durationSec: number }> {
    this._cancelPlayback();

    // Close any existing context (switching files)
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gainNode = null;
    }

    this._pcmCache.clear();
    this._pcmCacheOrder = [];
    this.preloadId++;  // cancel any ongoing preload from the previous file

    const info = await getFileInfo(path);
    this.filePath = path;
    this.fileSampleRate = info.sample_rate;
    this.fileChannels = info.channels;
    this.fileDurationSec = info.duration_secs;
    this.pausedAt = 0;

    return {
      sampleRate: info.sample_rate,
      channels: info.channels,
      durationSec: info.duration_secs,
    };
  }

  /**
   * Start playback from startSec, optionally stopping at endSec.
   * If endSec is omitted, plays to EOF.
   *
   * Must be called from a user gesture handler (click/keydown) so that the
   * AudioContext is created — or resumed — in a valid user gesture context.
   */
  play(startSec: number, endSec?: number): void {
    if (!this.filePath) return;

    this._cancelPlayback();

    // ── Create or reuse AudioContext ────────────────────────────────────────
    // Creating the context inside play() (a user gesture) ensures it starts
    // in 'running' state on WKWebView/Safari. If we already have a running
    // context (e.g. pausing and resuming), reuse it to avoid the latency of
    // re-creating it and to preserve ctx.currentTime continuity.
    if (!this.ctx || this.ctx.state === 'closed') {
      try {
        this.ctx = new AudioContext({ sampleRate: this.fileSampleRate });
      } catch {
        this.ctx = new AudioContext();
        console.warn(
          `AudioEngine: ${this.fileSampleRate} Hz not supported, using ${this.ctx.sampleRate} Hz`,
        );
      }
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this._currentGain;
      this.gainNode.connect(this.ctx.destination);
    } else if (this.ctx.state === 'suspended') {
      // Context exists but was suspended (shouldn't happen if we create in
      // play(), but handle it defensively).
      this.ctx.resume().catch(() => {});
    }

    const myPlayId = ++this.playId;
    this.isPlayingState = false;
    this.onPlayingFired = false;
    this.pausedAt = startSec;       // keep pausedAt in sync so getMediaTime() is correct during buffering
    this.playStartMedia = startSec;
    this.playStartCtxSet = false;   // anchored later: on first chunk (uncached) or immediately (cache hit)
    this.schedCursor = startSec;
    this.endSec = endSec ?? null;
    this.queue = [];
    this.chunksScheduled = 0;

    this._log(
      `play start=${startSec.toFixed(3)}s ${endSec !== undefined ? `end=${endSec.toFixed(3)}s ` : ''}`
      + `ctx.sr=${this.ctx.sampleRate} file.sr=${this.fileSampleRate} ch=${this.fileChannels} ctx.state=${this.ctx.state}`,
    );

    // ── PCM cache fast path ───────────────────────────────────────────────────
    // For bounded plays, skip Rust IPC entirely if we have cached decoded PCM
    // covering [startSec, endSec] (preload may have cached a larger range).
    if (this.endSec !== null) {
      const slice = this._pcmCacheFind(startSec, this.endSec);
      if (slice) {
        // PCM is already in memory — anchor immediately with minimum scheduling margin.
        this.playStartCtx = this.ctx.currentTime + START_MARGIN_SEC;
        this.playStartCtxSet = true;
        this._log(`cache hit: ${startSec.toFixed(3)}s–${this.endSec.toFixed(3)}s (${slice.frameCount} frames)`);
        this._playCached(slice, myPlayId);
        this._rafLoop(myPlayId);
        return;
      }
    }

    // ── Stuck-play watchdog ───────────────────────────────────────────────────
    // If no PCM chunks are scheduled within STUCK_PLAY_TIMEOUT_MS we assume
    // the Rust decode path is hung (seen with ogg/vorbis) and abort cleanly
    // so the UI can return to a useful state.
    this.stuckWatchdog = setTimeout(() => {
      if (this.playId !== myPlayId) return;
      if (this.chunksScheduled === 0) {
        this._log(
          `watchdog: no chunks scheduled after ${STUCK_PLAY_TIMEOUT_MS}ms — aborting (likely decoder hang)`,
          'error',
        );
        this._cancelPlayback();
        this.callbacks.onPaused();
      }
    }, STUCK_PLAY_TIMEOUT_MS);

    this._prefetchLoop(myPlayId);
    this._rafLoop(myPlayId);
  }

  pause(): void {
    if (!this.ctx) return;
    this.pausedAt = this._computeMediaTime();
    this._cancelPlayback();
    this.callbacks.onPaused();
  }

  get isPlaying(): boolean { return this.isPlayingState; }

  /** Update the playback start position without resuming. Caller calls play() to resume. */
  seek(sec: number): void {
    this.pausedAt = Math.max(0, Math.min(sec, this.fileDurationSec));
    this._cancelPlayback();
  }

  setGain(gain: number): void {
    this._currentGain = gain;
    if (this.gainNode) this.gainNode.gain.value = gain;
  }

  setMuted(muted: boolean): void {
    this._currentGain = muted ? 0 : 1;
    if (this.gainNode) this.gainNode.gain.value = this._currentGain;
  }

  /**
   * Current media time in seconds, tracking the audio clock while playing.
   * Returns the last known position while paused.
   */
  getMediaTime(): number {
    return this._computeMediaTime();
  }

  /** Fully tear down the engine. Call on component unmount. */
  dispose(): void {
    this._cancelPlayback();
    this.preloadId++;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.gainNode = null;
    this.filePath = null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _computeMediaTime(): number {
    if (!this.ctx || !this.isPlayingState) {
      // Not playing: return the last known position. pausedAt is kept in sync
      // by play() (set to startSec), pause() and seek() so this is always correct
      // whether we're paused, between play() and first sample, or at rest.
      return this.pausedAt;
    }
    const elapsed = this.ctx.currentTime - this.playStartCtx;
    if (elapsed < 0) return this.playStartMedia;
    const t = Math.min(this.playStartMedia + elapsed, this.fileDurationSec);
    // Clamp to endSec so the playhead never visually overshoots the selection
    // end during the window between source.stop() and _cancelPlayback().
    if (this.endSec !== null && t >= this.endSec) return this.endSec;
    return t;
  }

  /** Stop all sources and async loops. Does NOT call onPaused/onEnded. */
  private _cancelPlayback(): void {
    // Snapshot position before stopping
    this.pausedAt = this._computeMediaTime();

    // Increment playId — all async loops holding a stale id will exit
    this.playId++;

    if (this.stuckWatchdog !== null) {
      clearTimeout(this.stuckWatchdog);
      this.stuckWatchdog = null;
    }

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    // Stop all scheduled source nodes immediately
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const node of this.queue) {
        try { node.source.stop(now); } catch { /* already stopped */ }
      }
    }
    this.queue = [];

    // Close the active Rust stream asynchronously
    if (this.streamId !== null) {
      const id = this.streamId;
      this.streamId = null;
      closePcmStream(id).catch(() => {});
    }

    this.isPlayingState = false;
    this.onPlayingFired = false;
  }

  /** Async loop that fetches PCM chunks from Rust and schedules AudioBufferSourceNodes. */
  private async _prefetchLoop(myPlayId: number): Promise<void> {
    if (!this.ctx || !this.filePath) return;
    const ctx = this.ctx;
    const path = this.filePath;
    const ch = this.fileChannels;
    const sr = this.fileSampleRate;
    const chunkFrames = Math.floor(CHUNK_FRAMES_SEC * sr);

    // Open the Rust PcmStream at the playback start position
    let handle;
    try {
      handle = await startPcmStream(path, this.playStartMedia);
    } catch (err) {
      if (this.playId !== myPlayId) return;
      console.error('AudioEngine: startPcmStream failed', err);
      this._log(`startPcmStream failed: ${String(err)}`, 'error');
      // Fully tear down so the UI doesn't stay stuck in the "buffering" state
      // and the user can try another file cleanly. Without this, isBuffering
      // remains true on the React side and subsequent plays inherit the hang.
      this._cancelPlayback();
      this.callbacks.onPaused();
      return;
    }
    this._log(
      `stream opened id=${handle.stream_id} sr=${handle.sample_rate} ch=${handle.channels} total_frames=${handle.total_frames}`,
    );
    if (this.playId !== myPlayId) {
      closePcmStream(handle.stream_id).catch(() => {});
      return;
    }
    this.streamId = handle.stream_id;

    // `expectedNextCtxStart` tracks where the next chunk should be scheduled.
    // It's anchored when the first chunk arrives and advances by each chunk's duration.
    let expectedNextCtxStart = 0;
    let reachedEnd = false;

    while (this.playId === myPlayId) {
      // Don't over-buffer: wait while we have HORIZON_SEC of audio scheduled
      // ahead of the current play position.
      const currentMedia = this.isPlayingState
        ? this._computeMediaTime()
        : this.playStartMedia;
      const scheduledAhead = this.schedCursor - currentMedia;

      if (scheduledAhead >= HORIZON_SEC) {
        await sleep(SLEEP_MS);
        continue;
      }

      // Fetch the next chunk from Rust
      let chunk;
      try {
        chunk = await readPcmChunk(handle.stream_id, chunkFrames);
      } catch (err) {
        if (this.playId !== myPlayId) break;
        console.error('AudioEngine: readPcmChunk failed', err);
        this._log(`readPcmChunk failed: ${String(err)}`, 'error');
        // A mid-stream decode error would otherwise leave the engine "playing"
        // silence with no way to recover the UI. Cancel cleanly and notify.
        this._cancelPlayback();
        this.callbacks.onPaused();
        return;
      }
      if (this.playId !== myPlayId) break;

      if (chunk.frames_read === 0) {
        // EOF
        reachedEnd = true;
        break;
      }

      const chunkMediaStart = chunk.start_frame / sr;

      // ── Anchor playStartCtx on first chunk ─────────────────────────────────
      // Defer setting the time origin until PCM is actually in hand. This lets
      // audio start as soon as the IPC completes, with just enough lead time
      // for sample-accurate scheduling — no fixed pre-IPC delay.
      if (!this.playStartCtxSet) {
        this.playStartCtx = ctx.currentTime + START_MARGIN_SEC - (chunkMediaStart - this.playStartMedia);
        this.playStartCtxSet = true;
        expectedNextCtxStart = this.playStartCtx;
      }

      // ── Underrun detection and correction ──────────────────────────────────
      // If we couldn't schedule the chunk in time, bump the time origin forward
      // so mediaTime() stays continuous instead of jumping.
      if (expectedNextCtxStart < ctx.currentTime) {
        const gap = ctx.currentTime - expectedNextCtxStart;
        this.playStartCtx += gap;
        expectedNextCtxStart = ctx.currentTime + 0.02;
        this.callbacks.onBufferUnderrun();
      }

      // ── Compute context start time for this chunk ──────────────────────────
      // The chunk's media position is start_frame / sample_rate. We map that
      // to context time via: ctxTime = playStartCtx + (mediaSec - playStartMedia)
      const ctxStart = this.playStartCtx + (chunkMediaStart - this.playStartMedia);
      const chunkDurationSec = chunk.frames_read / sr;
      let ctxEnd = ctxStart + chunkDurationSec;

      // ── Build AudioBuffer from interleaved f32 samples ──────────────────────
      const framesToSchedule = chunk.frames_read;
      const audioBuffer = ctx.createBuffer(ch, framesToSchedule, sr);
      for (let c = 0; c < ch; c++) {
        const channelData = audioBuffer.getChannelData(c);
        for (let i = 0; i < framesToSchedule; i++) {
          channelData[i] = chunk.samples[i * ch + c];
        }
      }

      // ── Schedule the source node ────────────────────────────────────────────
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode!);
      source.start(ctxStart);

      // ── endSec stop: find the exact stop time if this chunk straddles endSec ─
      if (this.endSec !== null) {
        const chunkMediaEnd = chunkMediaStart + chunkDurationSec;
        if (chunkMediaStart < this.endSec && chunkMediaEnd >= this.endSec) {
          const secIntoChunk = this.endSec - chunkMediaStart;
          const stopCtxTime = ctxStart + secIntoChunk;
          source.stop(stopCtxTime);
          ctxEnd = stopCtxTime;
          reachedEnd = true; // don't schedule more chunks
        } else if (chunkMediaStart >= this.endSec) {
          // Past the end — don't schedule this chunk at all
          reachedEnd = true;
          break;
        }
      }

      this.queue.push({ source, mediaStart: chunkMediaStart, mediaEnd: chunkMediaStart + chunkDurationSec, ctxStart, ctxEnd });
      expectedNextCtxStart = ctxEnd;
      this.schedCursor = chunkMediaStart + chunkDurationSec;
      this.chunksScheduled++;
      if (this.chunksScheduled === 1) {
        this._log(`first chunk scheduled mediaStart=${chunkMediaStart.toFixed(3)}s frames=${framesToSchedule}`);
      }

      if (reachedEnd) break;
    }

    // Clean up stream
    if (this.streamId === handle.stream_id) {
      this.streamId = null;
      closePcmStream(handle.stream_id).catch(() => {});
    }

    // If we exited naturally (EOF or endSec), fire onEnded after the last
    // scheduled node finishes. We wait for the audio clock to pass ctxEnd.
    if (reachedEnd && this.playId === myPlayId) {
      const lastCtxEnd = this.queue.length > 0
        ? this.queue[this.queue.length - 1].ctxEnd
        : this.ctx?.currentTime ?? 0;
      const waitMs = Math.max(0, (lastCtxEnd - (this.ctx?.currentTime ?? 0)) * 1000 + 50);
      await sleep(waitMs);
      if (this.playId === myPlayId) {
        this._cancelPlayback();
        this.callbacks.onEnded();
      }
    }
  }

  // ── PCM cache helpers ────────────────────────────────────────────────────────

  private _pcmCacheKey(start: number, end: number): string {
    return `${this.filePath}:${start.toFixed(6)}:${end.toFixed(6)}`;
  }

  private _pcmCacheStore(start: number, end: number, channels: Float32Array[], totalFrames: number): void {
    const key = this._pcmCacheKey(start, end);
    if (this._pcmCache.has(key)) return;
    while (this._pcmCacheOrder.length >= MAX_PCM_CACHE_ENTRIES) {
      const oldest = this._pcmCacheOrder.shift()!;
      this._pcmCache.delete(oldest);
    }
    this._pcmCache.set(key, { channels, totalFrames, startSec: start, endSec: end });
    this._pcmCacheOrder.push(key);
  }

  /**
   * Find a cached entry whose range *contains* [reqStart, reqEnd] and return the
   * subrange to play. Searches MRU-first so the freshest entry wins when multiple
   * contain the request. Returns null on miss.
   */
  private _pcmCacheFind(reqStart: number, reqEnd: number): PcmCacheSlice | null {
    if (reqEnd <= reqStart) return null;
    const EPS = 1e-6;
    const sr = this.fileSampleRate;
    for (let i = this._pcmCacheOrder.length - 1; i >= 0; i--) {
      const key = this._pcmCacheOrder[i];
      const entry = this._pcmCache.get(key);
      if (!entry) continue;
      if (entry.startSec - EPS <= reqStart && entry.endSec + EPS >= reqEnd) {
        const startFrame = Math.max(0, Math.round((reqStart - entry.startSec) * sr));
        const endFrame = Math.min(entry.totalFrames, Math.round((reqEnd - entry.startSec) * sr));
        const frameCount = endFrame - startFrame;
        if (frameCount <= 0) continue;
        // Promote to MRU
        this._pcmCacheOrder.splice(i, 1);
        this._pcmCacheOrder.push(key);
        return { entry, startFrame, frameCount, startSec: reqStart, endSec: reqEnd };
      }
    }
    return null;
  }

  /**
   * Pre-decode and cache the PCM for [startSec, endSec] so subsequent plays in
   * that range start instantaneously. Safe to call repeatedly — if the range is
   * already covered by a cached entry, returns without decoding. Rapid calls
   * supersede each other via `preloadId`, so only the latest request completes.
   */
  async preloadRange(startSec: number, endSec: number): Promise<void> {
    if (!this.filePath || endSec <= startSec) return;
    if (this._pcmCacheFind(startSec, endSec)) return;

    const myPreloadId = ++this.preloadId;
    const path = this.filePath;
    const ch = this.fileChannels;
    const sr = this.fileSampleRate;
    const chunkFrames = Math.floor(CHUNK_FRAMES_SEC * sr);

    let handle;
    try {
      handle = await startPcmStream(path, startSec);
    } catch (err) {
      this._log(`preload startPcmStream failed: ${String(err)}`, 'error');
      return;
    }
    if (this.preloadId !== myPreloadId) {
      closePcmStream(handle.stream_id).catch(() => {});
      return;
    }

    const cacheChunks: Array<{ samples: number[]; frames: number }> = [];
    let cacheTotalFrames = 0;
    let reachedEnd = false;

    while (this.preloadId === myPreloadId) {
      let chunk;
      try {
        chunk = await readPcmChunk(handle.stream_id, chunkFrames);
      } catch (err) {
        this._log(`preload readPcmChunk failed: ${String(err)}`, 'error');
        closePcmStream(handle.stream_id).catch(() => {});
        return;
      }
      if (this.preloadId !== myPreloadId) break;
      if (chunk.frames_read === 0) { reachedEnd = true; break; }

      const chunkMediaStart = chunk.start_frame / sr;
      const chunkDurationSec = chunk.frames_read / sr;
      const chunkMediaEnd = chunkMediaStart + chunkDurationSec;

      let framesToCache = chunk.frames_read;
      if (chunkMediaEnd >= endSec) {
        framesToCache = Math.max(0, Math.min(Math.round((endSec - chunkMediaStart) * sr), chunk.frames_read));
        reachedEnd = true;
      }

      if (framesToCache > 0) {
        cacheChunks.push({ samples: chunk.samples.slice(0, framesToCache * ch), frames: framesToCache });
        cacheTotalFrames += framesToCache;
      }

      if (reachedEnd) break;
    }

    closePcmStream(handle.stream_id).catch(() => {});
    if (this.preloadId !== myPreloadId) return;

    if (reachedEnd && cacheChunks.length > 0) {
      const channels: Float32Array[] = Array.from({ length: ch }, () => new Float32Array(cacheTotalFrames));
      let frameOffset = 0;
      for (const { samples, frames } of cacheChunks) {
        for (let c = 0; c < ch; c++) {
          const dest = channels[c];
          for (let i = 0; i < frames; i++) {
            dest[frameOffset + i] = samples[i * ch + c];
          }
        }
        frameOffset += frames;
      }
      this._pcmCacheStore(startSec, endSec, channels, cacheTotalFrames);
      this._log(`preloaded ${startSec.toFixed(3)}s–${endSec.toFixed(3)}s (${cacheTotalFrames} frames)`);
    }
  }

  /**
   * Schedule a cached PCM slice directly, bypassing all Rust IPC.
   * Called from play() on a cache hit. Does NOT start the rAF loop — caller does that.
   */
  private _playCached(slice: PcmCacheSlice, myPlayId: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const sr = this.fileSampleRate;
    const { entry, startFrame, frameCount, startSec, endSec } = slice;

    const audioBuffer = ctx.createBuffer(entry.channels.length, frameCount, sr);
    for (let c = 0; c < entry.channels.length; c++) {
      audioBuffer.getChannelData(c).set(entry.channels[c].subarray(startFrame, startFrame + frameCount));
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode!);
    source.start(this.playStartCtx);

    const ctxEnd = this.playStartCtx + frameCount / sr;
    this.queue.push({
      source,
      mediaStart: startSec,
      mediaEnd: endSec,
      ctxStart: this.playStartCtx,
      ctxEnd,
    });
    this.schedCursor = endSec;
    this.chunksScheduled = 1;

    // Fire onEnded after the buffer finishes playing
    const waitMs = Math.max(0, (ctxEnd - ctx.currentTime) * 1000 + 50);
    setTimeout(() => {
      if (this.playId !== myPlayId) return;
      this._cancelPlayback();
      this.callbacks.onEnded();
    }, waitMs);
  }

  /** rAF loop: drives onTimeUpdate and fires onPlaying once audio starts. */
  private _rafLoop(myPlayId: number): void {
    if (this.playId !== myPlayId) return;

    if (this.ctx) {
      const ctxNow = this.ctx.currentTime;

      // Fire onPlaying the first time audio is actually being emitted. Guarded
      // by playStartCtxSet so we don't fire while waiting for the first chunk.
      if (!this.onPlayingFired && this.playStartCtxSet && ctxNow >= this.playStartCtx) {
        this.onPlayingFired = true;
        this.isPlayingState = true;
        this.callbacks.onPlaying();
      }

      const mt = this._computeMediaTime();
      this.callbacks.onTimeUpdate(mt);
    }

    this.rafHandle = requestAnimationFrame(() => this._rafLoop(myPlayId));
  }
}
