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

import { SoundTouch } from 'soundtouchjs';
import { getFileInfo, startPcmStream, readPcmChunk, closePcmStream } from './tauriCommands';
import { PhaseVocoder } from './PhaseVocoder';
import { BandPassFilter } from '../types';

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
/** Maximum number of preloaded regions to keep in the PCM replay cache. */
const MAX_PCM_CACHE_ENTRIES = 8;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  // Gain value applied at next gainNode creation (set via setGain before play)
  private _currentGain = 1;

  // ── Filter graph (persistent across plays) ──────────────────────────────────
  // Sources connect to _filterIn. Audio splits into a dry path (gain = 1-strength)
  // and a wet path (8-pole HP → 8-pole LP → gain = strength). Both paths join
  // at _filterOut, which feeds the master gainNode. When no filter is set,
  // _filterDry is at gain=1 and _filterWet at gain=0 — transparent passthrough.
  //
  // The wet path uses four cascaded biquads on each side, set to Butterworth
  // Q values for an 8th-order maximally flat response. -48 dB/oct rolloff is
  // steep enough that out-of-band content at full wet is effectively silent
  // (one octave outside the band lands around -51 dB, below most listening
  // thresholds). A single 2-pole biquad is too gentle (-12 dB/oct) and even
  // 4-pole leaves an audible halo, so we eat the extra biquads.
  private _filterIn: GainNode | null = null;
  private _filterDryDelay: DelayNode | null = null;
  private _filterDry: GainNode | null = null;
  private _filterHP: BiquadFilterNode[] = [];
  private _filterLP: BiquadFilterNode[] = [];
  private _filterWet: GainNode | null = null;
  private _filterOut: GainNode | null = null;
  private bandPassFilter: BandPassFilter | null = null;
  /** Measured group delay of the wet biquad chain (seconds, ctx-time domain).
   *  Mirrored on the dry-path DelayNode and subtracted from playhead. 0 when
   *  no filter is set. */
  private _filterDelaySec = 0;
  /** Monotonic token so a stale async measurement can't overwrite a fresher one. */
  private _filterDelayMeasurementToken = 0;

  // ── Time-stretch ───────────────────────────────────────────────────────────
  // playbackSpeed > 1 → audio plays faster than real time; speed < 1 → slower.
  // Pitch is preserved by one of two engines, picked per play() based on speed:
  // phase vocoder for slowdowns, SoundTouch (WSOLA) for speedups. Both are
  // allocated lazily and reset at the start of each play().
  private playbackSpeed = 1.0;
  private _phaseVocoder: PhaseVocoder | null = null;
  /** Channel count the current _phaseVocoder was allocated for (PV's channel
   *  count is fixed at construction). Set when allocated, checked on reuse. */
  private _phaseVocoderChannels = 0;
  private _soundTouch: SoundTouch | null = null;
  /** Which engine the current play() is using; null when not stretching. */
  private _activeStretchEngine: 'pv' | 'st' | null = null;

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
   *  the slow-decode notice to detect when a decode has opened but not yet delivered. */
  private chunksScheduled = 0;
  private slowDecodeTimer: ReturnType<typeof setInterval> | null = null;
  private playStartedAtMs = 0;

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
      this._teardownFilterGraph();
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
    if (this.playbackSpeed < 1.0) {
      const pvChannels = 2;  // _stretchChunk always produces stereo output
      if (!this._phaseVocoder || this._phaseVocoderChannels !== pvChannels) {
        this._phaseVocoder = new PhaseVocoder(pvChannels);
        this._phaseVocoderChannels = pvChannels;
      }
      this._phaseVocoder.reset();
      this._phaseVocoder.setSpeed(this.playbackSpeed);
      this._activeStretchEngine = 'pv';
    } else if (this.playbackSpeed > 1.0) {
      if (!this._soundTouch) this._soundTouch = new SoundTouch();
      this._soundTouch.clear();
      this._soundTouch.tempo = this.playbackSpeed;
      this._soundTouch.pitch = 1.0;
      this._activeStretchEngine = 'st';
    } else {
      this._activeStretchEngine = null;
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
      + `speed=${this.playbackSpeed.toFixed(2)}x ctx.sr=${this.ctx.sampleRate} file.sr=${this.fileSampleRate} ch=${this.fileChannels} ctx.state=${this.ctx.state}`,
    );

    // ── PCM cache fast path ───────────────────────────────────────────────────
    // For bounded plays, skip Rust IPC entirely if we have cached decoded PCM
    // covering [startSec, endSec] (preload may have cached a larger range).
    // Cache hits are only used at speed=1.0 — the cache stores raw PCM, and
    // re-stretching it through SoundTouch on every replay would defeat the
    // "instant repeat" purpose. Stretched plays go through the prefetch path.
    if (this.endSec !== null && this.playbackSpeed === 1.0) {
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
    this.pausedAt = Math.max(0, Math.min(sec, this.fileDurationSec));
    this._cancelPlayback();
    // Cancel any in-flight preload for the old position (finding 6).
    this.preloadId++;
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
   * Set the playback speed (0.25x–4.0x). Pitch is preserved.
   * Changing speed during playback restarts from the current playhead so the
   * new speed applies immediately rather than after the existing scheduled
   * audio horizon drains.
   */
  setPlaybackSpeed(speed: number): void {
    const next = Math.max(0.25, Math.min(4.0, speed));
    if (Math.abs(next - this.playbackSpeed) < 0.001) return;
    const wasPlaying = this.isPlayingState;
    const resumeFrom = wasPlaying ? this._computeMediaTime() : this.pausedAt;
    const resumeEnd = this.endSec;
    this.playbackSpeed = next;
    if (wasPlaying) {
      this.play(resumeFrom, resumeEnd ?? undefined);
    }
  }

  getPlaybackSpeed(): number {
    return this.playbackSpeed;
  }

  /**
   * Apply a band-pass filter to the playback path. `null` removes any active
   * filter. The change is applied to the persistent filter graph in real time
   * via setValueAtTime, so no audio is restarted.
   */
  setBandPassFilter(filter: BandPassFilter | null): void {
    this.bandPassFilter = filter;
    this._applyFilterToGraph();
  }

  getBandPassFilter(): BandPassFilter | null {
    return this.bandPassFilter;
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
    this._teardownFilterGraph();
    this._phaseVocoder = null;
    this._phaseVocoderChannels = 0;
    this._soundTouch = null;
    this._activeStretchEngine = null;
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
    // Subtract the band-pass filter's group delay so the playhead reflects
    // what's emerging from the speakers, not what's been scheduled into the
    // filter chain. _filterDelaySec is 0 when no filter is active.
    const elapsedCtx = this.ctx.currentTime - this.playStartCtx - this._filterDelaySec;
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
    const ctx = this.ctx;
    // Q values for an 8th-order Butterworth response from four cascaded biquads.
    // Pole-pair angles π/16, 3π/16, 5π/16, 7π/16 → Q = 1/(2 cos θ).
    const BUTTERWORTH_8_Q = [0.5097955, 0.6013372, 0.9000000, 2.5629154];
    this._filterIn = ctx.createGain();
    this._filterOut = ctx.createGain();
    this._filterDry = ctx.createGain();
    this._filterWet = ctx.createGain();
    // Max delay 0.5s is way more than any realistic biquad group delay.
    this._filterDryDelay = ctx.createDelay(0.5);

    this._filterHP = BUTTERWORTH_8_Q.map(q => {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.Q.value = q;
      return f;
    });
    this._filterLP = BUTTERWORTH_8_Q.map(q => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = q;
      return f;
    });

    // Dry path: filterIn → filterDryDelay → filterDry → filterOut.
    // The DelayNode matches the wet branch's group delay so the wet/dry mix
    // is phase-coherent at any strength (no comb filtering).
    this._filterIn.connect(this._filterDryDelay);
    this._filterDryDelay.connect(this._filterDry);
    this._filterDry.connect(this._filterOut);
    // Wet path: filterIn → HP[0..3] → LP[0..3] → filterWet → filterOut
    let prev: AudioNode = this._filterIn;
    for (const hp of this._filterHP) { prev.connect(hp); prev = hp; }
    for (const lp of this._filterLP) { prev.connect(lp); prev = lp; }
    prev.connect(this._filterWet);
    this._filterWet.connect(this._filterOut);

    this._filterOut.connect(this.gainNode);

    this._applyFilterToGraph();
  }

  private _teardownFilterGraph(): void {
    const all: (AudioNode | null)[] = [
      this._filterIn, this._filterDryDelay, this._filterDry,
      this._filterWet, this._filterOut,
      ...this._filterHP, ...this._filterLP,
    ];
    for (const node of all) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
    this._filterIn = null;
    this._filterDryDelay = null;
    this._filterDry = null;
    this._filterHP = [];
    this._filterLP = [];
    this._filterWet = null;
    this._filterOut = null;
    this._filterDelaySec = 0;
    this._filterDelayMeasurementToken++; // invalidate any pending measurement
  }

  private _applyFilterToGraph(): void {
    if (!this.ctx || !this._filterDry || !this._filterWet
        || this._filterHP.length === 0 || this._filterLP.length === 0) return;
    const t = this.ctx.currentTime;
    if (this.bandPassFilter) {
      const { low, high, strength } = this.bandPassFilter;
      const safeLow = Math.max(20, Math.min(low, this.fileSampleRate / 2 - 20));
      const safeHigh = Math.max(safeLow + 20, Math.min(high, this.fileSampleRate / 2 - 1));
      for (const hp of this._filterHP) hp.frequency.setValueAtTime(safeLow, t);
      for (const lp of this._filterLP) lp.frequency.setValueAtTime(safeHigh, t);
      const s = Math.max(0, Math.min(1, strength));
      this._filterDry.gain.setValueAtTime(1 - s, t);
      this._filterWet.gain.setValueAtTime(s, t);
      void this._updateFilterDelay(safeLow, safeHigh);
    } else {
      this._filterDry.gain.setValueAtTime(1, t);
      this._filterWet.gain.setValueAtTime(0, t);
      this._filterDelaySec = 0;
      this._filterDelayMeasurementToken++;
      this._filterDryDelay?.delayTime.setValueAtTime(0, t);
    }
  }

  /**
   * Measure the wet chain's group delay for the given cutoffs and apply it to
   * the dry-path DelayNode + _filterDelaySec. Async because measurement runs
   * in an OfflineAudioContext; uses a token so out-of-order completion of a
   * stale measurement can't clobber a fresher one.
   */
  private async _updateFilterDelay(low: number, high: number): Promise<void> {
    const token = ++this._filterDelayMeasurementToken;
    const ctx = this.ctx;
    if (!ctx) return;
    const sampleRate = ctx.sampleRate;
    let delaySec: number;
    try {
      delaySec = await this._measureWetGroupDelay(low, high, sampleRate);
    } catch {
      return;
    }
    if (token !== this._filterDelayMeasurementToken) return;
    if (!this.ctx || !this._filterDryDelay) return;
    const now = this.ctx.currentTime;
    this._filterDelaySec = delaySec;
    this._filterDryDelay.delayTime.setValueAtTime(delaySec, now);
  }

  /**
   * Render an impulse through an offline copy of the wet chain and return the
   * peak position of |response| in seconds — a close-enough proxy for group
   * delay for our purposes (we only need to remove ~tens-of-ms of visual drift,
   * not chase sub-sample accuracy). Cheap: a single offline render of <500ms
   * of audio through 8 biquads.
   */
  private async _measureWetGroupDelay(low: number, high: number, sampleRate: number): Promise<number> {
    const BUTTERWORTH_8_Q = [0.5097955, 0.6013372, 0.9000000, 2.5629154];
    const length = Math.ceil(0.5 * sampleRate);
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const impulseBuf = offline.createBuffer(1, length, sampleRate);
    impulseBuf.getChannelData(0)[0] = 1;
    const source = offline.createBufferSource();
    source.buffer = impulseBuf;

    let prev: AudioNode = source;
    for (const q of BUTTERWORTH_8_Q) {
      const hp = offline.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = low;
      hp.Q.value = q;
      prev.connect(hp);
      prev = hp;
    }
    for (const q of BUTTERWORTH_8_Q) {
      const lp = offline.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = high;
      lp.Q.value = q;
      prev.connect(lp);
      prev = lp;
    }
    prev.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peakVal) { peakVal = v; peakIdx = i; }
    }
    return peakIdx / sampleRate;
  }

  /**
   * Push deinterleaved input PCM through the active stretch engine and pull
   * whatever output frames are currently available. Both engines emit stereo,
   * so mono input is duplicated L=R and >2-channel input is downmixed.
   *
   * `isFinal` is honored only by the phase vocoder (it has tail samples that
   * would otherwise be lost on EOF). SoundTouch buffers minimally per chunk,
   * so the flag is a no-op there.
   */
  private _stretchChunk(
    inputChannels: Float32Array[],
    inputFrames: number,
    isFinal: boolean,
  ): { left: Float32Array; right: Float32Array; outputFrames: number } {
    if (this._activeStretchEngine === 'pv') {
      return this._stretchChunkPV(inputChannels, inputFrames, isFinal);
    }
    return this._stretchChunkST(inputChannels, inputFrames);
  }

  private _stretchChunkPV(
    inputChannels: Float32Array[],
    inputFrames: number,
    isFinal: boolean,
  ): { left: Float32Array; right: Float32Array; outputFrames: number } {
    const pv = this._phaseVocoder!;
    const numCh = inputChannels.length;

    if (inputFrames > 0) {
      let stereoIn: Float32Array[];
      if (numCh === 1) {
        stereoIn = [inputChannels[0], inputChannels[0]];
      } else if (numCh === 2) {
        stereoIn = inputChannels;
      } else {
        const mono = new Float32Array(inputFrames);
        for (let i = 0; i < inputFrames; i++) {
          let sum = 0;
          for (let c = 0; c < numCh; c++) sum += inputChannels[c][i];
          mono[i] = sum / numCh;
        }
        stereoIn = [mono, mono];
      }
      pv.pushInput(stereoIn, inputFrames);
    }

    if (isFinal) pv.flush();

    const outputFrames = pv.available();
    if (outputFrames === 0) {
      return { left: new Float32Array(0), right: new Float32Array(0), outputFrames: 0 };
    }
    const left = new Float32Array(outputFrames);
    const right = new Float32Array(outputFrames);
    pv.pullOutput([left, right], outputFrames);
    return { left, right, outputFrames };
  }

  private _stretchChunkST(
    inputChannels: Float32Array[],
    inputFrames: number,
  ): { left: Float32Array; right: Float32Array; outputFrames: number } {
    if (inputFrames === 0) {
      return { left: new Float32Array(0), right: new Float32Array(0), outputFrames: 0 };
    }
    const st = this._soundTouch!;
    const stereoInput = new Float32Array(inputFrames * 2);
    const numCh = inputChannels.length;
    if (numCh === 1) {
      const m = inputChannels[0];
      for (let i = 0; i < inputFrames; i++) {
        stereoInput[i * 2] = m[i];
        stereoInput[i * 2 + 1] = m[i];
      }
    } else if (numCh === 2) {
      const l = inputChannels[0];
      const r = inputChannels[1];
      for (let i = 0; i < inputFrames; i++) {
        stereoInput[i * 2] = l[i];
        stereoInput[i * 2 + 1] = r[i];
      }
    } else {
      for (let i = 0; i < inputFrames; i++) {
        let sum = 0;
        for (let c = 0; c < numCh; c++) sum += inputChannels[c][i];
        const avg = sum / numCh;
        stereoInput[i * 2] = avg;
        stereoInput[i * 2 + 1] = avg;
      }
    }

    st.inputBuffer.putSamples(stereoInput, 0, inputFrames);
    st.process();

    const outputFrames = st.outputBuffer.frameCount;
    if (outputFrames === 0) {
      return { left: new Float32Array(0), right: new Float32Array(0), outputFrames: 0 };
    }
    const stereoOutput = new Float32Array(outputFrames * 2);
    st.outputBuffer.receiveSamples(stereoOutput, outputFrames);
    const left = new Float32Array(outputFrames);
    const right = new Float32Array(outputFrames);
    for (let i = 0; i < outputFrames; i++) {
      left[i] = stereoOutput[i * 2];
      right[i] = stereoOutput[i * 2 + 1];
    }
    return { left, right, outputFrames };
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
          const tail = this._stretchChunk([], 0, true);
          if (tail.outputFrames > 0) {
            const ctxStart = expectedNextCtxStart;
            const tailDurationSec = tail.outputFrames / sr;
            const ctxEnd = ctxStart + tailDurationSec;
            const ab = ctx.createBuffer(2, tail.outputFrames, sr);
            ab.getChannelData(0).set(tail.left);
            ab.getChannelData(1).set(tail.right);
            const source = ctx.createBufferSource();
            source.buffer = ab;
            source.connect(this._filterIn ?? this.gainNode!);
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
        const out = this._stretchChunk(inputChannels, inputFrames, isFinalChunk);
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
      source.connect(this._filterIn ?? this.gainNode!);
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
    // Key on integer frame indices rather than fractional seconds: at 48 kHz,
    // .toFixed(6) only has ~0.048-sample resolution, so adjacent sample-distinct
    // seek targets can collide on the same key (finding 4).
    const sr = this.fileSampleRate;
    const startFrame = Math.round(start * sr);
    const endFrame = Math.round(end * sr);
    return `${this.filePath}:${startFrame}:${endFrame}`;
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
    const chunkFrames = Math.floor(CHUNK_DURATION_SEC * sr);

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
    source.connect(this._filterIn ?? this.gainNode!);
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
