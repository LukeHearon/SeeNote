/**
 * AudioEngine — sample-accurate playback via scheduled AudioBufferSourceNodes
 *
 * ── Time model ────────────────────────────────────────────────────────────────
 *   ctxTime        = audioCtx.currentTime          (monotonic real-audio clock)
 *   playStartCtx   = ctxTime when .start(when) was called for the first sample
 *   playStartMedia = file position (seconds) of that first sample
 *   speed          = playbackSpeed (1.0 = normal, 2.0 = twice as fast, etc.)
 *   mediaTime(now) = playStartMedia + (ctxTime - playStartCtx) * speed
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
 *
 * ── Time-stretch (pitch-preserving) ───────────────────────────────────────────
 * When playbackSpeed != 1, each PCM chunk is processed through one of two
 * stretch engines, chosen for quality on the relevant content:
 *   - speed < 1: streaming phase vocoder (utils/PhaseVocoder.ts). Smoother
 *     than WSOLA on tonal/sustained content at extreme slowdowns.
 *   - speed > 1: SoundTouchJS (WSOLA). Preserves transient sharpness much
 *     better than a phase vocoder at speedup; phase vocoder smears clicks.
 * The stretched output has a different frame count than the input
 * (≈ inputFrames / speed) but preserves pitch. Output frames are scheduled
 * back-to-back on the ctx clock, and mediaTime is computed by the linear
 * relationship above.
 *
 * ── Band-pass filter ──────────────────────────────────────────────────────────
 * A persistent filter graph sits between the chunk source nodes and the master
 * gain node. It implements a wet/dry crossfade: the dry path passes the source
 * through a matched DelayNode, and the wet path goes through cascaded
 * highpass+lowpass biquads. setBandPassFilter() updates the cutoff frequencies
 * and the wet/dry mix in real time without rerouting nodes (so it never causes
 * a click).
 *
 * The cascaded biquads have non-trivial group delay (tens of ms near the
 * cutoffs), so the wet branch is shifted in time relative to the input. To
 * preserve sample-for-sample sync between what the user sees (playhead) and
 * what they hear, we (a) match that delay on the dry branch via a DelayNode so
 * the wet/dry mix is phase-coherent regardless of strength, and (b) subtract
 * the measured group delay from _computeMediaTime() so the playhead lines up
 * with the audio actually leaving the speakers. The delay value is measured
 * empirically by rendering an impulse through an offline copy of the wet chain
 * whenever the cutoffs change.
 */

import { getFileInfo, startPcmStream, readPcmChunk, closePcmStream } from './tauriCommands';
import { RafTicker } from './rafTicker';
import { BandPassFilter, PlaybackTransport } from '../types';
import { clamp } from './helpers';
import { TimeStretchEngine } from './TimeStretchEngine';
import { PcmCache, PcmCacheSlice } from './PcmCache';
import { BandPassFilterGraph } from './BandPassFilterGraph';

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
  /** Optional: emitted for notable engine events (opens, errors, slow-decode notices, etc.). */
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * Interval at which we emit a debug-log notice while play() is still waiting
 * for the first PCM chunk. The loading spinner already tells the user the app
 * isn't frozen; this is purely for diagnosing slow-decode reports. The user
 * can hit pause at any time — _cancelPlayback() will bump playId and tear
 * down the dangling stream/await chain cleanly.
 */
const SLOW_DECODE_LOG_INTERVAL_MS = 5000;

/** Metadata for one scheduled AudioBufferSourceNode. */
interface ScheduledNode {
  source: AudioBufferSourceNode;
  mediaStart: number;
  mediaEnd: number;
  ctxStart: number;
  ctxEnd: number;
}

/** How many frames to fetch per IPC call (~1 second of audio). */
const CHUNK_DURATION_SEC = 1.0;
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

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export class AudioEngine implements PlaybackTransport {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  // Gain value applied at next gainNode creation (set via setGain before play)
  private _currentGain = 1;

  // ── Filter graph (persistent across plays) ──────────────────────────────────
  // The band-pass filter graph sits between the chunk source nodes and the
  // master gainNode. Sources connect to `_filterInput` (the graph's input node);
  // the graph's output feeds gainNode. Owned and managed by BandPassFilterGraph.
  private filterGraph = new BandPassFilterGraph();
  /** Cached graph input node so source nodes can connect to the wet/dry split. */
  private _filterInput: AudioNode | null = null;
  private bandPassFilter: BandPassFilter | null = null;

  // ── Time-stretch ───────────────────────────────────────────────────────────
  // playbackSpeed > 1 → audio plays faster than real time; speed < 1 → slower.
  // Pitch is preserved by one of two engines, picked per play() based on speed:
  // phase vocoder for slowdowns, SoundTouch (WSOLA) for speedups. Both are
  // allocated lazily and reset at the start of each play(). Owned by
  // TimeStretchEngine.
  private playbackSpeed = 1.0;
  private timeStretch = new TimeStretchEngine();

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

  private _raf = new RafTicker();
  /** Number of PCM chunks successfully scheduled in the current play(). Used by
   *  the slow-decode notice to detect when a decode has opened but not yet delivered. */
  private chunksScheduled = 0;
  private slowDecodeTimer: ReturnType<typeof setInterval> | null = null;
  private playStartedAtMs = 0;

  private callbacks: AudioEngineCallbacks;

  // ── PCM replay cache ────────────────────────────────────────────────────────
  // Decoded PCM for preloaded regions. On a cache hit, play() bypasses all
  // Rust IPC and schedules directly from the stored Float32Arrays. Owned by
  // PcmCache, which holds its own `preloadId` generation token (distinct from
  // this.playId).
  private pcmCache = new PcmCache((msg, type) => this._log(msg, type));

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
      this._teardownFilterGraph();
    }

    this.pcmCache.clear();  // also cancels any ongoing preload from the previous file

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

    // Reset time-origin fields so _computeMediaTime() never reads a stale
    // playStartCtx from the previous play() during the brief window between
    // _cancelPlayback() and the first chunk arriving (finding 3).
    this.playStartCtx = 0;
    this.playStartCtxSet = false;

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
      this._buildFilterGraph();
    } else if (this.ctx.state === 'suspended') {
      // Context exists but was suspended (shouldn't happen if we create in
      // play(), but handle it defensively).
      this.ctx.resume().catch(() => {});
    }

    // ── Initialise the appropriate stretch engine ─────────────────────────────
    // Phase vocoder for slowdowns, SoundTouch (WSOLA) for speedups. Each engine
    // is allocated lazily and reset on every play() so internal buffers start clean.
    this.timeStretch.setSpeed(this.playbackSpeed);
    this.timeStretch.reset();

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
      + `speed=${this.playbackSpeed.toFixed(2)}x ctx.sr=${this.ctx.sampleRate} file.sr=${this.fileSampleRate} ch=${this.fileChannels} ctx.state=${this.ctx.state}`,
    );

    // Only surface latency when it's high enough to perceptibly desync the
    // playhead (>20ms). At that point _outputLatencySec() is actively shifting
    // the cursor, and the log explains why. Stays silent on normal wired output.
    const latencySec = this._outputLatencySec();
    if (latencySec > 0.02) {
      const ol = (this.ctx as { outputLatency?: number }).outputLatency;
      this._log(
        `output latency ${(latencySec * 1000).toFixed(0)}ms `
        + `(outLatency=${typeof ol === 'number' ? ol.toFixed(3) : 'n/a'}s baseLatency=${this.ctx.baseLatency?.toFixed(3) ?? 'n/a'}s) `
        + `— playhead compensated`,
      );
    }

    // ── PCM cache fast path ───────────────────────────────────────────────────
    // For bounded plays, skip Rust IPC entirely if we have cached decoded PCM
    // covering [startSec, endSec] (preload may have cached a larger range).
    // Cache hits are only used at speed=1.0 — the cache stores raw PCM, and
    // re-stretching it through SoundTouch on every replay would defeat the
    // "instant repeat" purpose. Stretched plays go through the prefetch path.
    if (this.endSec !== null && this.playbackSpeed === 1.0) {
      const slice = this.pcmCache.find(this.fileSampleRate, startSec, this.endSec);
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

    // ── Slow-decode notice ────────────────────────────────────────────────────
    // Emit a debug-log line every SLOW_DECODE_LOG_INTERVAL_MS while we're still
    // waiting on the first chunk. Diagnostic only — playback is not aborted.
    // The user can pause at any time; _cancelPlayback() handles the dangling
    // startPcmStream await via the playId guard.
    this.playStartedAtMs = performance.now();
    this.slowDecodeTimer = setInterval(() => {
      if (this.playId !== myPlayId || this.chunksScheduled > 0) {
        if (this.slowDecodeTimer !== null) {
          clearInterval(this.slowDecodeTimer);
          this.slowDecodeTimer = null;
        }
        return;
      }
      const elapsedMs = Math.round(performance.now() - this.playStartedAtMs);
      this._log(`still waiting for first chunk after ${elapsedMs}ms (slow decode)`);
    }, SLOW_DECODE_LOG_INTERVAL_MS);

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
    this.pausedAt = clamp(sec, 0, this.fileDurationSec);
    this._cancelPlayback();
    // Cancel any in-flight preload for the old position (finding 6).
    this.pcmCache.cancelPreload();
  }

  setGain(gain: number): void {
    this._currentGain = gain;
    if (this.gainNode) this.gainNode.gain.value = gain;
  }

  /**
   * Set the playback speed (0.25x–4.0x). Pitch is preserved.
   * Changing speed during playback restarts from the current playhead so the
   * new speed applies immediately rather than after the existing scheduled
   * audio horizon drains.
   */
  setPlaybackSpeed(speed: number): void {
    const next = clamp(speed, 0.25, 4.0);
    if (Math.abs(next - this.playbackSpeed) < 0.001) return;
    const wasPlaying = this.isPlayingState;
    const resumeFrom = wasPlaying ? this._computeMediaTime() : this.pausedAt;
    const resumeEnd = this.endSec;
    this.playbackSpeed = next;
    if (wasPlaying) {
      this.play(resumeFrom, resumeEnd ?? undefined);
    }
  }

  /**
   * Apply a band-pass filter to the playback path. `null` removes any active
   * filter. The change is applied to the persistent filter graph in real time
   * via setValueAtTime, so no audio is restarted.
   */
  setBandPassFilter(filter: BandPassFilter | null): void {
    this.bandPassFilter = filter;
    this.filterGraph.apply(filter, this.fileSampleRate);
  }

  /**
   * Current media time in seconds, tracking the audio clock while playing.
   * Returns the last known position while paused.
   */
  getMediaTime(): number {
    return this._computeMediaTime();
  }

  /**
   * Close and discard the current AudioContext so the next play() creates a
   * fresh one. Useful when the OS audio device changes (e.g. Bluetooth
   * headphones reconnected on Windows). Playback is cancelled first; the
   * file metadata and PCM cache are preserved so playback can resume
   * immediately after the context is recreated.
   */
  async restart(): Promise<void> {
    this._cancelPlayback();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gainNode = null;
      this._teardownFilterGraph();
    }
  }

  /** Fully tear down the engine. Call on component unmount. */
  dispose(): void {
    this._cancelPlayback();
    this.pcmCache.cancelPreload();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.gainNode = null;
    this._teardownFilterGraph();
    this.timeStretch.dispose();
    this.filePath = null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Output latency (seconds) between scheduling a sample at ctx.currentTime and
   * it actually reaching the speakers. `ctx.currentTime` advances the instant a
   * buffer is scheduled, but the audio subsystem buffers it for this long before
   * it's audible. On built-in/wired output this is a few ms; on Bluetooth it can
   * be 200–300ms; WKWebView's Web Audio render pipeline buffers heavily on macOS
   * regardless of the physical device. Subtracting it from the playhead keeps the
   * cursor on the audio actually leaving the speakers rather than the audio just
   * scheduled — same correction pattern as _filterDelaySec.
   *
   * Prefer `outputLatency` (full path to the output device); fall back to
   * `baseLatency` (context → audio subsystem) when unavailable; 0 if neither is
   * reported (no correction, original behaviour).
   */
  private _outputLatencySec(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const ol = (ctx as { outputLatency?: number }).outputLatency;
    if (typeof ol === 'number' && isFinite(ol) && ol > 0) return ol;
    const bl = ctx.baseLatency;
    if (typeof bl === 'number' && isFinite(bl) && bl > 0) return bl;
    return 0;
  }

  private _computeMediaTime(): number {
    if (!this.ctx || !this.isPlayingState) {
      // Not playing: return the last known position. pausedAt is kept in sync
      // by play() (set to startSec), pause() and seek() so this is always correct
      // whether we're paused, between play() and first sample, or at rest.
      return this.pausedAt;
    }
    // Subtract the band-pass filter's group delay AND the audio output latency so
    // the playhead reflects what's emerging from the speakers, not what's been
    // scheduled. Both are 0 when inactive/unreported.
    const elapsedCtx = this.ctx.currentTime - this.playStartCtx - this.filterGraph.getDelaySec() - this._outputLatencySec();
    if (elapsedCtx < 0) return this.playStartMedia;
    const t = Math.min(this.playStartMedia + elapsedCtx * this.playbackSpeed, this.fileDurationSec);
    // Clamp to endSec so the playhead never visually overshoots the selection
    // end during the window between source.stop() and _cancelPlayback().
    if (this.endSec !== null && t >= this.endSec) return this.endSec;
    return t;
  }

  /**
   * Build the persistent filter graph between the chunk source nodes and the
   * master gainNode. Created once per AudioContext (in play() when the ctx is
   * first instantiated) and torn down with the context.
   */
  private _buildFilterGraph(): void {
    if (!this.ctx || !this.gainNode) return;
    const { input, output } = this.filterGraph.build(this.ctx);
    this._filterInput = input;
    output.connect(this.gainNode);
    // Reapply the current filter to the freshly built graph.
    this.filterGraph.apply(this.bandPassFilter, this.fileSampleRate);
  }

  private _teardownFilterGraph(): void {
    this.filterGraph.teardown();
    this._filterInput = null;
  }

  /** Stop all sources and async loops. Does NOT call onPaused/onEnded. */
  private _cancelPlayback(): void {
    // Snapshot position before stopping
    this.pausedAt = this._computeMediaTime();

    // Increment playId — all async loops holding a stale id will exit
    this.playId++;

    if (this.slowDecodeTimer !== null) {
      clearInterval(this.slowDecodeTimer);
      this.slowDecodeTimer = null;
    }

    this._raf.stop();

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
    const speed = this.playbackSpeed;
    const stretching = speed !== 1.0;
    const chunkFrames = Math.floor(CHUNK_DURATION_SEC * sr);

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

    // Generation token: if a concurrent play() cancels this stream and opens a new
    // one, `this.streamId` will no longer match `handle.stream_id`.  Combined with
    // the `this.playId === myPlayId` guard, this prevents a stale loop from
    // scheduling onto the wrong generation's queue or state (finding 1).
    while (this.playId === myPlayId && this.streamId === handle.stream_id) {
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
        // EOF — drain the phase vocoder tail (~fftSize/2 samples of unflushed
        // OLA buffer) so the trailing audio doesn't get cut off. Without this,
        // selection plays at slow speed lose noticeable audio at the end.
        reachedEnd = true;
        if (stretching) {
          const tail = this.timeStretch.stretch([], 0, true);
          if (tail.outputFrames > 0) {
            const ctxStart = expectedNextCtxStart;
            const tailDurationSec = tail.outputFrames / sr;
            const ctxEnd = ctxStart + tailDurationSec;
            const ab = ctx.createBuffer(2, tail.outputFrames, sr);
            ab.getChannelData(0).set(tail.left);
            ab.getChannelData(1).set(tail.right);
            const source = ctx.createBufferSource();
            source.buffer = ab;
            source.connect(this._filterInput ?? this.gainNode!);
            source.start(ctxStart);
            this.queue.push({
              source,
              mediaStart: this.schedCursor,
              mediaEnd: this.schedCursor,
              ctxStart,
              ctxEnd,
            });
            expectedNextCtxStart = ctxEnd;
          }
        }
        break;
      }

      const chunkMediaStart = chunk.start_frame / sr;
      const inputFrames = chunk.frames_read;
      const inputDurationSec = inputFrames / sr;
      const chunkMediaEnd = chunkMediaStart + inputDurationSec;
      const isFinalChunk = this.endSec !== null && chunkMediaEnd >= this.endSec;

      // ── Anchor playStartCtx on first chunk ─────────────────────────────────
      // Defer setting the time origin until PCM is actually in hand. This lets
      // audio start as soon as the IPC completes, with just enough lead time
      // for sample-accurate scheduling — no fixed pre-IPC delay.
      // The factor of `1/speed` accounts for the time-stretch: media time
      // advances `speed` times faster than ctx time during playback.
      if (!this.playStartCtxSet) {
        this.playStartCtx = ctx.currentTime + START_MARGIN_SEC - (chunkMediaStart - this.playStartMedia) / speed;
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

      // ── Build deinterleaved input for this chunk ───────────────────────────
      const inputChannels: Float32Array[] = [];
      for (let c = 0; c < ch; c++) {
        const cd = new Float32Array(inputFrames);
        for (let i = 0; i < inputFrames; i++) {
          cd[i] = chunk.samples[i * ch + c];
        }
        inputChannels.push(cd);
      }

      // ── Apply time-stretch if needed and pick output channel layout ────────
      let outputChannels: Float32Array[];
      let outputFrames: number;
      if (stretching) {
        const out = this.timeStretch.stretch(inputChannels, inputFrames, isFinalChunk);
        if (out.outputFrames === 0) {
          // Vocoder buffered the input but hasn't accumulated a full window
          // yet (only happens for the very first sub-window of input). Skip
          // scheduling but advance the input cursor so we keep feeding it.
          this.schedCursor = chunkMediaEnd;
          continue;
        }
        outputChannels = [out.left, out.right];
        outputFrames = out.outputFrames;
      } else {
        outputChannels = inputChannels;
        outputFrames = inputFrames;
      }

      // ── Compute context start time for this chunk's OUTPUT ─────────────────
      // For stretched audio, output ctx duration = input media duration / speed.
      // Use the running `expectedNextCtxStart` so successive chunks butt up
      // against each other regardless of how many frames SoundTouch produced.
      const ctxStart = expectedNextCtxStart;
      const outputDurationSec = outputFrames / sr;
      let ctxEnd = ctxStart + outputDurationSec;

      // ── Build AudioBuffer ──────────────────────────────────────────────────
      const audioBuffer = ctx.createBuffer(outputChannels.length, outputFrames, sr);
      for (let c = 0; c < outputChannels.length; c++) {
        audioBuffer.getChannelData(c).set(outputChannels[c]);
      }

      // ── Schedule the source node ────────────────────────────────────────────
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._filterInput ?? this.gainNode!);
      source.start(ctxStart);

      // ── endSec stop: stop at the ctx time that maps to mediaTime = endSec ──
      // For stretched chunks, the output covers media [chunkMediaStart, chunkMediaEnd]
      // over context duration outputDurationSec. The ctx time at endSec is:
      //   ctxStart + (endSec - chunkMediaStart) / speed
      if (this.endSec !== null) {
        if (chunkMediaStart < this.endSec && chunkMediaEnd >= this.endSec) {
          const stopCtxTime = ctxStart + (this.endSec - chunkMediaStart) / speed;
          source.stop(stopCtxTime);
          ctxEnd = stopCtxTime;
          reachedEnd = true;
        } else if (chunkMediaStart >= this.endSec) {
          reachedEnd = true;
          break;
        }
      }

      this.queue.push({ source, mediaStart: chunkMediaStart, mediaEnd: chunkMediaEnd, ctxStart, ctxEnd });
      expectedNextCtxStart = ctxEnd;
      this.schedCursor = chunkMediaEnd;
      this.chunksScheduled++;
      if (this.chunksScheduled === 1) {
        const elapsedMs = Math.round(performance.now() - this.playStartedAtMs);
        this._log(`first chunk scheduled mediaStart=${chunkMediaStart.toFixed(3)}s in=${inputFrames}f out=${outputFrames}f (${elapsedMs}ms after play)`);
        if (this.slowDecodeTimer !== null) {
          clearInterval(this.slowDecodeTimer);
          this.slowDecodeTimer = null;
        }
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
      const waitMs = Math.max(0, (lastCtxEnd - (this.ctx?.currentTime ?? 0) + this._outputLatencySec()) * 1000 + 50);
      await sleep(waitMs);
      if (this.playId === myPlayId) {
        this._cancelPlayback();
        this.callbacks.onEnded();
      }
    }
  }

  // ── PCM cache ────────────────────────────────────────────────────────────────

  /**
   * Pre-decode and cache the PCM for [startSec, endSec] so subsequent plays in
   * that range start instantaneously. Delegates to PcmCache; see preloadRange there.
   */
  async preloadRange(startSec: number, endSec: number): Promise<void> {
    if (!this.filePath) return;
    await this.pcmCache.preloadRange(this.filePath, this.fileChannels, this.fileSampleRate, startSec, endSec);
  }

  /**
   * Schedule a cached PCM slice directly, bypassing all Rust IPC.
   * Called from play() on a cache hit. Only used at speed=1.0 (see play()).
   * Does NOT start the rAF loop — caller does that.
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
    source.connect(this._filterInput ?? this.gainNode!);
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

    // Fire onEnded after the buffer finishes playing. Add output latency so the
    // teardown (which snapshots pausedAt via _computeMediaTime) lands after the
    // audio is actually audible through endSec, not when it was merely scheduled.
    const waitMs = Math.max(0, (ctxEnd - ctx.currentTime + this._outputLatencySec()) * 1000 + 50);
    setTimeout(() => {
      if (this.playId !== myPlayId) return;
      this._cancelPlayback();
      this.callbacks.onEnded();
    }, waitMs);
  }

  /** rAF loop: drives onTimeUpdate and fires onPlaying once audio starts. */
  private _rafLoop(myPlayId: number): void {
    const frame = () => {
      // Stale play() — stop ticking (also stopped by _cancelPlayback, which
      // bumps playId; this guards a frame that slips through in between).
      if (this.playId !== myPlayId) { this._raf.stop(); return; }

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
    };
    // First body run is synchronous (as before); schedule subsequent frames
    // only if this play() is still current (matches the original guard, which
    // returned without rescheduling when stale).
    frame();
    if (this.playId === myPlayId) this._raf.start(frame);
  }
}
