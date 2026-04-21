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

/** How many frames to fetch per IPC call (~1 second of audio). */
const CHUNK_FRAMES_SEC = 1.0;
/** How many seconds of audio to keep scheduled ahead of the play position. */
const HORIZON_SEC = 4.0;
/** How long to sleep (ms) when the buffer is full before checking again. */
const SLEEP_MS = 250;
/** How far in the future (seconds) to schedule the first sample. Gives the
 *  first IPC fetch time to complete before audio starts. */
const START_DELAY_SEC = 0.2;

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
  private playStartCtx = 0;        // ctx time of first scheduled sample
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
    this.pausedAt = startSec;       // keep pausedAt in sync so getMediaTime() is correct during start delay
    this.playStartMedia = startSec;
    this.schedCursor = startSec;
    this.endSec = endSec ?? null;
    this.queue = [];
    this.chunksScheduled = 0;

    // Schedule the first sample slightly in the future so the prefetch loop
    // has time to fetch the first chunk before playback begins.
    this.playStartCtx = this.ctx.currentTime + START_DELAY_SEC;

    this._log(
      `play start=${startSec.toFixed(3)}s ${endSec !== undefined ? `end=${endSec.toFixed(3)}s ` : ''}`
      + `ctx.sr=${this.ctx.sampleRate} file.sr=${this.fileSampleRate} ch=${this.fileChannels} ctx.state=${this.ctx.state}`,
    );

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
    // It starts at playStartCtx and advances by each chunk's duration.
    let expectedNextCtxStart = this.playStartCtx;
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
      const chunkMediaStart = chunk.start_frame / sr;
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

  /** rAF loop: drives onTimeUpdate and fires onPlaying once audio starts. */
  private _rafLoop(myPlayId: number): void {
    if (this.playId !== myPlayId) return;

    if (this.ctx) {
      const ctxNow = this.ctx.currentTime;

      // Fire onPlaying the first time audio is actually being emitted
      if (!this.onPlayingFired && ctxNow >= this.playStartCtx) {
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
