/**
 * AudioEngine — sample-accurate playback via scheduled AudioBufferSourceNodes
 *
 * ── Time model ────────────────────────────────────────────────────────────────
 *   ctxTime        = audioCtx.currentTime          (monotonic real-audio clock)
 *   playStartCtx   = ctxTime when .start(when) was called for the first sample
 *   playStartMedia = DISPLAY position (seconds) of that first sample
 *   speed          = playbackSpeed (1.0 = normal, 2.0 = twice as fast, etc.)
 *   mediaTime(now) = playStartMedia + (ctxTime - playStartCtx) * speed
 *
 * While paused, getMediaTime() returns the last known position. While buffering
 * before the scheduled start, the playhead is parked at playStartMedia.
 *
 * Every time on this engine's public surface — play/seek/getMediaTime/endSec —
 * is DISPLAY time (see utils/subsetTimeline.ts). With no subset that is the same
 * thing as a position in the file. With a subset it is a position on the shorter
 * timeline made of only the kept spans, and the linear relation above still
 * holds exactly: the display axis is what plays back continuously. Source
 * positions are derived from it only where the file is actually read
 * (_prefetchLoop opening streams, the PCM cache).
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
 * ── Subset playback (spans) ───────────────────────────────────────────────────
 * Under a subset timeline the loop reads only within the current span, then
 * closes that stream, opens one at the next span's source start, and keeps
 * scheduling against the SAME running `expectedNextCtxStart`. Because chunks are
 * butted together on the context clock rather than triggered when they arrive,
 * the join is sample-contiguous — there is no gap to hear. The stream swap is
 * covered by the HORIZON_SEC of audio already scheduled, so the open latency
 * never reaches the speakers.
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
import { deinterleave } from './pcm';
import { BandPassFilterGraph } from './BandPassFilterGraph';
import { Timeline, identityTimeline } from './subsetTimeline';

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
  /** Called once the chunk following an underrun has been scheduled — i.e. the
   *  gap is closed and audio is flowing again. Pairs with onBufferUnderrun so a
   *  "buffering" indicator can be cleared; without it the indicator raised
   *  mid-play would stay up for the rest of the play. */
  onBufferRecovered: () => void;
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
  /** ctxEnd this node would have had without a bounded play's stop(endSec)
   *  truncation — i.e. the end of its buffer. Equal to ctxEnd when untruncated.
   *  clearEndSec() re-stops the tail node here to reclaim the truncated audio. */
  naturalCtxEnd: number;
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
/** Lead time given to a chunk that missed its slot, so `source.start(when)` is
 *  still scheduling into the future after the buffer work that follows it.
 *  Whatever this is, it must be folded into the time origin along with the
 *  overrun itself — see the underrun branch in _prefetchLoop. */
const UNDERRUN_LEAD_SEC = 0.02;
/** Longest gap between two subset spans that's cheaper to decode past than to
 *  seek over. A seek reopens the container; a couple of seconds of throwaway
 *  decode does not. See the span-advance in _prefetchLoop. */
const GAP_READ_THROUGH_SEC = 2.0;

/** Grace period added to the render check's due time (see _armRenderCheck), on
 *  top of the reported output latency, before the device is judged late. */
const RENDER_CHECK_MARGIN_SEC = 0.25;
/** How far the device may trail `ctx.currentTime`, beyond the latency it
 *  reports, before the render check logs. Sized to sit well above normal jitter
 *  so the line means something when it appears. */
const RENDER_LAG_ALERT_SEC = 0.15;
/** How long after the first sample is due to be audible the latency probe
 *  samples the output clock (see _armLatencyProbe). Long enough for the device
 *  to have settled into steady state, short enough to land inside a short
 *  selection's play. */
const LATENCY_PROBE_DELAY_SEC = 0.2;
/** Smallest change in reported output latency worth a log line. Below this it's
 *  measurement noise; above it, the audio device or its buffer size changed
 *  under us, which moves the delay before sound. */
const LATENCY_CHANGE_LOG_SEC = 0.005;
/** How often the playback clock monitor samples (see _startClockDriftMonitor).
 *  Short enough that a one-second selection still produces a line. */
const CLOCK_DRIFT_SAMPLE_MS = 500;
/** Wall time that must pass before the monitor's first line: below this the
 *  numbers are dominated by the sample interval itself. */
const CLOCK_DRIFT_FIRST_LOG_SEC = 0.9;
/** Additional drift or timer overshoot (seconds) beyond the last logged figure
 *  worth another line. */
const CLOCK_DRIFT_LOG_STEP_SEC = 0.1;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export class AudioEngine implements PlaybackTransport {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  // Brickwall-ish limiter sitting between the master gain and the output device.
  // Protects the listener when the volume slider (or normalization) drives the
  // signal hot: output can't run far past the threshold no matter the gain.
  private limiterNode: DynamicsCompressorNode | null = null;
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

  // ── Timeline ────────────────────────────────────────────────────────────────
  // Maps the display axis this engine plays back to positions in the file. The
  // identity timeline (subset off) makes the two the same, so every path below
  // is written once and runs unchanged either way.
  private timeline: Timeline = identityTimeline(0);

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
  // Last known SCHEDULED position (no output-latency/filter-delay compensation),
  // snapshotted alongside pausedAt. This — not pausedAt — is where playback must
  // resume from: see getResumeTime().
  private pausedAtSched = 0;
  // True once this bounded play's stop point is baked into the audio graph (a
  // source node scheduled with stop(endSec), or a whole cached slice). After
  // that, clearEndSec() can no longer take effect by simply nulling endSec.
  private endBoundCommitted = false;
  // Bumped by clearEndSec(). The pending onEnded of a bounded play (in the
  // _prefetchLoop tail and _playCached's timer) captures this and stays silent
  // if it changed — the end bound it was going to report no longer exists.
  private endBoundEpoch = 0;

  // Scheduled nodes that haven't finished yet. Pruned every frame by
  // _pruneQueue() — an entry keeps its AudioBufferSourceNode alive, and that
  // keeps a second of decoded PCM alive with it.
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
  /** One-shot timer armed by the first scheduled chunk (see _armRenderCheck). */
  private renderCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last output latency reported to the log, so a change is only logged once.
   *  Negative until the first sample. */
  private lastLoggedLatencySec = -1;
  /** One-shot timer armed alongside the render check (see _armLatencyProbe). */
  private latencyProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Repeating timer comparing the context clock to the wall clock during a
   *  play (see _startClockDriftMonitor), with the origins it measures from. */
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private driftCtxOrigin = 0;
  private driftWallOriginMs = 0;
  private driftLastLoggedSec = 0;
  /** Hardware sample rate of the default output device as of the most recent
   *  context creation, from a throwaway context opened without a `sampleRate`
   *  option. Null until first probed; 0 if the probe failed with nothing
   *  previously measured. Never treated as still true for the next context —
   *  see _probeDeviceSampleRate. */
  private deviceSampleRate: number | null = null;

  private callbacks: AudioEngineCallbacks;

  /** Set by dispose(), never cleared: this engine is dead for good.
   *
   * Nulling filePath in dispose() is not a sufficient guard on its own, because
   * loadFile() re-sets it from a continuation that can resume *after* dispose
   * (it awaits getFileInfo over IPC). A caller doing the usual
   * `loadFile(p).then(() => engine.play(0))` would then reach play(), find no
   * context, and open a brand-new AudioContext — audio that nothing holds a
   * reference to any more, so nothing can ever pause or close it. Every entry
   * point that could start or resume audio checks this first. */
  private disposed = false;

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
    if (this.disposed) throw new Error('AudioEngine.loadFile after dispose()');
    this._cancelPlayback();

    // Close any existing context (switching files)
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gainNode = null;
      this.limiterNode = null;
      this._teardownFilterGraph();
    }

    this.pcmCache.clear();  // also cancels any ongoing preload from the previous file

    const info = await getFileInfo(path);
    // Disposed while the metadata IPC was in flight — do not re-arm the engine.
    if (this.disposed) throw new Error('AudioEngine disposed while loading');
    this.filePath = path;
    this.fileSampleRate = info.sample_rate;
    this.fileChannels = info.channels;
    // Source duration lives on the timeline (identity until a subset is set).
    this.timeline = identityTimeline(info.duration_secs);
    this.pausedAt = 0;

    return {
      sampleRate: info.sample_rate,
      channels: info.channels,
      durationSec: info.duration_secs,
    };
  }

  /**
   * Swap the display↔source timeline (subset toggled, threshold changed, …).
   *
   * Playback stops rather than being remapped mid-flight: the audio already
   * scheduled belongs to the old timeline, and everything downstream of the
   * playhead — the spectrogram, the panel, the selection — is re-derived from
   * the new one in the same commit. Resuming is one keypress; a playhead that
   * kept running against a timeline nobody else was using any more would be a
   * lie about what's being heard.
   */
  setTimeline(timeline: Timeline): void {
    const wasPlaying = this.isPlayingState;
    this.timeline = timeline;
    this._cancelPlayback();
    // Park the cursors at a position the new timeline can express.
    const t = clamp(this.pausedAt, 0, timeline.duration);
    this.pausedAt = t;
    this.pausedAtSched = t;
    this.pcmCache.cancelPreload();
    if (wasPlaying) this.callbacks.onPaused();
  }

  /** The display duration currently in effect (the whole file when no subset). */
  get displayDuration(): number { return this.timeline.duration; }

  /**
   * Start playback from startSec, optionally stopping at endSec.
   * If endSec is omitted, plays to EOF.
   *
   * Must be called from a user gesture handler (click/keydown) so that the
   * AudioContext is created — or resumed — in a valid user gesture context.
   */
  play(startSec: number, endSec?: number): void {
    if (this.disposed || !this.filePath) return;
    // A subset that kept nothing has no spans and so no audio to play. Bail
    // before the prefetch loop tries to resolve a position on an empty axis.
    if (this.timeline.spans.length === 0) return;

    // Stamped here, at the top, so every "Nms after play" line below measures
    // from the call — including the cache-hit path, which returns before the
    // streaming path's own bookkeeping.
    this.playStartedAtMs = performance.now();

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
      // Open at the OUTPUT DEVICE's rate, not the file's. Asking for the file's
      // rate is what keeps our own graph resample-free, but when it isn't the
      // device's rate the audio subsystem resamples on the way out, and on
      // WKWebView/macOS that path buffers deeply — deep enough to put a second
      // or more between scheduling a sample and hearing it, none of which is
      // reported in `outputLatency`. Nothing in the scheduling math cares:
      // chunks are still built as AudioBuffers at the file's rate (Web Audio
      // resamples each one), and a buffer's duration in seconds is
      // frames / its own rate either way.
      //
      // Set localStorage['seenote.audioContextRate'] = 'file' to force the old
      // behaviour for an A/B on the latency.
      const deviceRate = this._probeDeviceSampleRate();
      let forceFileRate = false;
      try { forceFileRate = localStorage.getItem('seenote.audioContextRate') === 'file'; } catch { /* no storage */ }
      const wantedRate = !forceFileRate && deviceRate > 0 ? deviceRate : this.fileSampleRate;
      try {
        this.ctx = new AudioContext({ sampleRate: wantedRate });
      } catch {
        this.ctx = new AudioContext();
        console.warn(
          `AudioEngine: ${wantedRate} Hz not supported, using ${this.ctx.sampleRate} Hz`,
        );
      }
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this._currentGain;
      this.limiterNode = this.ctx.createDynamicsCompressor();
      this.limiterNode.threshold.value = -2;   // dBFS ceiling
      this.limiterNode.knee.value = 0;         // hard knee — acts as a limiter
      this.limiterNode.ratio.value = 20;
      this.limiterNode.attack.value = 0.003;
      this.limiterNode.release.value = 0.1;
      this.gainNode.connect(this.limiterNode);
      this.limiterNode.connect(this.ctx.destination);
      this._buildFilterGraph();
      // A context that suspends or is interrupted mid-play keeps ctx.currentTime
      // (and so the playhead) advancing on some implementations while nothing
      // reaches the speakers. Logged for the whole life of the context, not just
      // during a play, since the transition often lands between two plays.
      this.ctx.addEventListener('statechange', () => {
        this._log(`ctx.state -> ${this.ctx?.state ?? 'closed'}`);
      });
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
    this.pausedAtSched = startSec;
    this.playStartMedia = startSec;
    this.endBoundCommitted = false;
    this.playStartCtxSet = false;   // anchored later: on first chunk (uncached) or immediately (cache hit)
    this.schedCursor = startSec;
    this.endSec = endSec ?? null;
    this.queue = [];
    this.chunksScheduled = 0;

    this._log(
      `play start=${startSec.toFixed(3)}s ${endSec !== undefined ? `end=${endSec.toFixed(3)}s ` : ''}`
      + `speed=${this.playbackSpeed.toFixed(2)}x ctx.sr=${this.ctx.sampleRate} file.sr=${this.fileSampleRate} ch=${this.fileChannels} ctx.state=${this.ctx.state}`,
    );

    this._logOutputLatency();

    // ── PCM cache fast path ───────────────────────────────────────────────────
    // For bounded plays, skip Rust IPC entirely if we have cached decoded PCM
    // covering [startSec, endSec] (preload may have cached a larger range).
    // Cache hits are only used at speed=1.0 — the cache stores raw PCM, and
    // re-stretching it through SoundTouch on every replay would defeat the
    // "instant repeat" purpose. Stretched plays go through the prefetch path.
    // Under a subset the cache is only consulted for a play that stays inside
    // one span: the cache holds contiguous file PCM, which a play crossing a cut
    // is not (see _sourceRangeWithinOneSpan).
    const cacheSrc = this.endSec !== null ? this._sourceRangeWithinOneSpan(startSec, this.endSec) : null;
    if (cacheSrc && this.playbackSpeed === 1.0) {
      const slice = this.pcmCache.find(this.fileSampleRate, cacheSrc.start, cacheSrc.end);
      if (slice) {
        // PCM is already in memory — anchor immediately with minimum scheduling margin.
        this.playStartCtx = this.ctx.currentTime + START_MARGIN_SEC;
        this.playStartCtxSet = true;
        this._log(`cache hit: ${startSec.toFixed(3)}s–${this.endSec!.toFixed(3)}s (${slice.frameCount} frames)`);
        this._playCached(slice, startSec, this.endSec!, myPlayId);
        this._rafLoop(myPlayId);
        return;
      }
    }

    // ── Slow-decode notice ────────────────────────────────────────────────────
    // Emit a debug-log line every SLOW_DECODE_LOG_INTERVAL_MS while we're still
    // waiting on the first chunk. Diagnostic only — playback is not aborted.
    // The user can pause at any time; _cancelPlayback() handles the dangling
    // startPcmStream await via the playId guard.
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
    // _cancelPlayback() snapshots both cursors; call it unconditionally so a
    // play() still awaiting its first chunk (no ctx-dependent state yet) still
    // has its playId bumped and its stream/await chain torn down.
    this._cancelPlayback();
    this.callbacks.onPaused();
  }

  get isPlaying(): boolean { return this.isPlayingState; }

  /**
   * Where a resume must start so no audio is repeated or skipped.
   *
   * getMediaTime() is compensated for output latency and filter group delay: it
   * reports what is coming out of the speakers *now*, which lags what has been
   * scheduled by that latency L. But pause() cannot un-render audio already
   * handed to the device — everything through the scheduled cursor S will still
   * be heard. Resuming from the compensated position replays [S-L, S], which on
   * Bluetooth output (L ≈ 150–300ms) is an audible stutter/echo. So resume from
   * S instead; the playhead stays continuous because the new play() re-subtracts
   * L from its own anchor.
   */
  getResumeTime(): number {
    return this.isPlayingState ? this._computeMediaTime(false) : this.pausedAtSched;
  }

  /**
   * Drop this play's endSec so playback runs on to natural EOF (the selection
   * that bounded it was cancelled mid-play). Audible continuity is the whole
   * point here, so this never restarts playback — a restart tears down the Web
   * Audio graph and reopens the Rust stream, which is the hiccup it exists to
   * avoid.
   *
   * Cheap path: if the chunk containing endSec hasn't been scheduled yet, the
   * prefetch loop re-reads this.endSec every iteration, so nulling it is enough.
   *
   * Once the stop IS baked into the graph — source.stop(endSec) on the tail
   * chunk, or a cached slice covering exactly the selection — we instead
   * *extend* the existing play:
   *   1. Re-stop the tail node at its buffer end, reclaiming the audio the
   *      truncation cut off (the spec makes the last stop() call the effective
   *      one, provided the node hasn't stopped yet).
   *   2. Start a continuation prefetch loop that schedules from schedCursor,
   *      butted up against that tail on the ctx clock. Same playId, nothing
   *      cancelled: the already-scheduled audio keeps playing while the new
   *      stream opens behind it.
   *   3. Suppress the pending onEnded via endBoundEpoch.
   * The tail is the cover that hides the stream-open latency. It's the rest of
   * the selection on the cached path (the common case: selections are preloaded
   * on commit) and up to one chunk on the streaming path.
   */
  clearEndSec(): void {
    // _cancelPlayback() nulls endSec, so a non-null value here means a bounded
    // play really is in flight (not one that already ended or was paused).
    if (this.endSec === null) return;
    const committed = this.endBoundCommitted;
    this.endSec = null;
    this.endBoundCommitted = false;
    if (!committed) return;

    this.endBoundEpoch++;
    const tail = this.queue[this.queue.length - 1];
    if (!tail || !this.ctx) return;

    if (tail.naturalCtxEnd > tail.ctxEnd && this.ctx.currentTime < tail.ctxEnd) {
      try {
        tail.source.stop(tail.naturalCtxEnd);
        tail.ctxEnd = tail.naturalCtxEnd;
      } catch { /* already stopped — the cover is just shorter */ }
    }
    this._log(`endSec cleared; continuing from ${this.schedCursor.toFixed(3)}s `
      + `(${((tail.ctxEnd - this.ctx.currentTime) * 1000).toFixed(0)}ms of scheduled audio in hand)`);
    this._prefetchLoop(this.playId, tail.ctxEnd);
  }

  /** Update the playback start position without resuming. Caller calls play() to resume. */
  seek(sec: number): void {
    if (this.disposed) return;
    const target = clamp(sec, 0, this.timeline.duration);
    this._cancelPlayback();
    // After _cancelPlayback (which snapshots the pre-seek position), point both
    // cursors at the seek target: an explicit seek discards whatever is still
    // draining out of the device buffer, so there's nothing to resume past.
    this.pausedAt = target;
    this.pausedAtSched = target;
    // Cancel any in-flight preload for the old position (finding 6).
    this.pcmCache.cancelPreload();
  }

  setGain(gain: number): void {
    this._currentGain = gain;
    if (!this.gainNode) return;
    // Short ramp so a big slider jump (or a scroll flick) doesn't click.
    if (this.ctx) {
      this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
    } else {
      this.gainNode.gain.value = gain;
    }
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
    if (this.disposed) return;
    this._cancelPlayback();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gainNode = null;
      this.limiterNode = null;
      this._teardownFilterGraph();
    }
  }

  /** Fully tear down the engine. Call on component unmount. Irreversible —
   *  every start/resume path no-ops afterwards (see `disposed`). */
  dispose(): void {
    this.disposed = true;
    this._cancelPlayback();
    this.pcmCache.cancelPreload();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.gainNode = null;
    this.limiterNode = null;
    this._teardownFilterGraph();
    this.timeStretch.dispose();
    this.filePath = null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * The source range a display range [d0, d1] corresponds to, or null when the
   * range crosses a cut. Everything that treats audio as one contiguous run of
   * file samples — the PCM cache, the preloader — is only valid within a single
   * span, so both go through here rather than assuming the two axes agree.
   */
  private _sourceRangeWithinOneSpan(d0: number, d1: number): { start: number; end: number } | null {
    if (this.timeline.identity) return { start: d0, end: d1 };
    const spans = this.timeline.spans;
    const i = this.timeline.spanIndexAtDisplay(d0);
    const s = spans[i];
    if (!s) return null;
    const spanEndDisp = s.dispStart + (s.srcEnd - s.srcStart);
    // A hair of slack: a selection snapped to a span's end can land a float
    // ulp past it, and that shouldn't cost the cache path.
    if (d1 > spanEndDisp + 1e-9) return null;
    return {
      start: s.srcStart + (d0 - s.dispStart),
      end: s.srcStart + (d1 - s.dispStart),
    };
  }

  /** Source position of a display time known to sit in span `i`. */
  private _srcInSpan(i: number, disp: number): number {
    const s = this.timeline.spans[i];
    return s.srcStart + (disp - s.dispStart);
  }

  /** Display position of a source time known to sit in span `i`. */
  private _dispInSpan(i: number, src: number): number {
    const s = this.timeline.spans[i];
    return s.dispStart + (src - s.srcStart);
  }

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

  /**
   * Hardware sample rate of the default output device, measured fresh.
   *
   * We open our context at the device's rate: when it isn't, the audio subsystem
   * resamples on the way out, and that resampler's buffering is deep and is not
   * reported in `outputLatency` — a delay before sound that nothing in the logs
   * explains. Measured from a throwaway context created with no `sampleRate`
   * option (which therefore opens at the device rate) and closed immediately.
   *
   * Re-probed on every context creation, never cached across one. The device can
   * change under a running app — headphones plugged in, output switched, a
   * display or interface waking — and a rate remembered from the last device is
   * exactly how we end up asking for the wrong one and buying the resampler we
   * opened at the device rate to avoid. That failure survives file switches
   * (which rebuild the context but would reuse the stale number) and clears only
   * on a fresh engine, which is what "quit and reopen fixes it" looks like.
   *
   * Called when our own context is created, never while audio is playing: a
   * second context opening can make CoreAudio reconsider the device, and a
   * measurement that disturbs what it measures is worse than none.
   */
  private _probeDeviceSampleRate(): number {
    const prev = this.deviceSampleRate;
    try {
      const probe = new AudioContext();
      this.deviceSampleRate = probe.sampleRate;
      probe.close().catch(() => {});
    } catch {
      // Probe failed: keep the last good reading rather than falling back to the
      // file's rate, which is the resampling case we're trying to avoid.
      this.deviceSampleRate = prev ?? 0;
    }
    if (prev !== null && prev !== this.deviceSampleRate) {
      this._log(`output device rate changed ${prev}Hz -> ${this.deviceSampleRate}Hz`);
    }
    return this.deviceSampleRate;
  }

  /**
   * Log what the output side actually did, shortly after the first sample was
   * due to be audible. Unconditional — unlike _logOutputLatency and the render
   * check, both of which stay silent when the browser reports a small latency,
   * which is precisely the case where sound is late and nothing explains it.
   *
   * Prints the reported latency next to the measured one. `getOutputTimestamp()`
   * gives the context position actually played out, so `currentTime - contextTime`
   * is the real distance between scheduling and hearing. When that measurement
   * is much larger than `outputLatency`, the playhead compensation — which trusts
   * `outputLatency` — is short by the difference, and the cursor runs ahead of
   * the sound by exactly that much.
   */
  private _armLatencyProbe(firstCtxStart: number, myPlayId: number): void {
    if (this.latencyProbeTimer !== null) clearTimeout(this.latencyProbeTimer);
    const ctx = this.ctx;
    if (!ctx) return;
    const dueInSec = firstCtxStart - ctx.currentTime + LATENCY_PROBE_DELAY_SEC;
    this.latencyProbeTimer = setTimeout(() => {
      this.latencyProbeTimer = null;
      if (this.playId !== myPlayId || !this.ctx) return;
      const c = this.ctx as AudioContext & { outputLatency?: number };
      const ol = typeof c.outputLatency === 'number' ? `${(c.outputLatency * 1000).toFixed(1)}ms` : 'n/a';
      const bl = typeof c.baseLatency === 'number' ? `${(c.baseLatency * 1000).toFixed(1)}ms` : 'n/a';
      const measured = this._renderLagSec();
      const dev = this.deviceSampleRate ?? 0;
      // An exact 0 means getOutputTimestamp() handed back contextTime ===
      // currentTime, which WKWebView does whatever the device is doing. Marked,
      // because read as a measurement it says "no real latency" and is the one
      // reading here that cannot say that.
      const measuredStr = measured === null ? 'unavailable'
        : measured === 0 ? '0.0ms (contextTime===currentTime; not a real reading)'
        : `${(measured * 1000).toFixed(1)}ms`;
      this._log(
        `latency probe: reported out=${ol} base=${bl} — `
        + `measured(getOutputTimestamp)=${measuredStr} — `
        + `compensating ${(this._outputLatencySec() * 1000).toFixed(1)}ms out `
        + `+ ${(this.filterGraph.getDelaySec() * 1000).toFixed(1)}ms filter — `
        + `ctx.sr=${this.ctx.sampleRate} device.sr=${dev || 'unknown'} (probed at ctx open)`,
      );
    }, Math.max(0, dueInSec * 1000));
  }

  /**
   * Watch the two clocks that can put a delay between an action and the sound,
   * for the length of a play. One timer, two independent measurements:
   *
   * - **ctx vs wall.** `ctx.currentTime` is supposed to be the audio device's
   *   clock. If it instead advances on a render thread outrunning the device —
   *   what an output path with a growing FIFO looks like from inside the page —
   *   it gains on `performance.now()`, and every sample we schedule lands that
   *   much further behind the speakers. `getOutputTimestamp()` is the API for
   *   this and WKWebView answers it with zero lag; two independent clocks can't
   *   be faked the same way.
   * - **Timer overshoot.** How late this interval fires against its own period,
   *   i.e. how far behind the event loop is running. A main thread backed up by
   *   a second delays the keypress, the scheduling and the playhead together —
   *   which sounds exactly like output latency but isn't, and is the reading
   *   that tells the two apart.
   *
   * A healthy play holds both within a few ms.
   */
  private _startClockDriftMonitor(myPlayId: number): void {
    this._stopClockDriftMonitor();
    const ctx = this.ctx;
    if (!ctx) return;
    this.driftCtxOrigin = ctx.currentTime;
    this.driftWallOriginMs = performance.now();
    this.driftLastLoggedSec = 0;
    let firstLogged = false;
    let lastTickMs = this.driftWallOriginMs;
    let maxOvershootSec = 0;
    this.driftTimer = setInterval(() => {
      if (this.playId !== myPlayId || !this.ctx) { this._stopClockDriftMonitor(); return; }
      const nowMs = performance.now();
      const overshootSec = (nowMs - lastTickMs - CLOCK_DRIFT_SAMPLE_MS) / 1000;
      lastTickMs = nowMs;
      if (overshootSec > maxOvershootSec) maxOvershootSec = overshootSec;
      const ctxElapsed = this.ctx.currentTime - this.driftCtxOrigin;
      const wallElapsed = (nowMs - this.driftWallOriginMs) / 1000;
      if (wallElapsed <= 0) return;
      const excess = ctxElapsed - wallElapsed;
      const worst = Math.max(Math.abs(excess), maxOvershootSec);
      const worthLogging = worst >= this.driftLastLoggedSec + CLOCK_DRIFT_LOG_STEP_SEC;
      if (!worthLogging && (firstLogged || wallElapsed < CLOCK_DRIFT_FIRST_LOG_SEC)) return;
      firstLogged = true;
      if (worthLogging) this.driftLastLoggedSec = worst;
      this._log(
        `clocks: ctx +${ctxElapsed.toFixed(3)}s vs wall +${wallElapsed.toFixed(3)}s `
        + `— ctx ${excess >= 0 ? 'ahead' : 'behind'} by ${Math.abs(excess * 1000).toFixed(0)}ms `
        + `— event loop worst overshoot ${(maxOvershootSec * 1000).toFixed(0)}ms `
        + `— filter delay ${(this.filterGraph.getDelaySec() * 1000).toFixed(0)}ms`,
      );
    }, CLOCK_DRIFT_SAMPLE_MS);
  }

  private _stopClockDriftMonitor(): void {
    if (this.driftTimer !== null) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
  }

  /**
   * Log the output latency when it is high enough to perceptibly desync the
   * playhead (>20ms) or when it has changed since the last line. The change
   * case matters more than the absolute value: the delay before sound moves
   * with it, and a device swapping under a running app (Bluetooth connecting,
   * output switching, a buffer-size change) is otherwise invisible — including
   * across plays, which is why `lastLoggedLatencySec` is not reset per play.
   */
  private _logOutputLatency(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const latencySec = this._outputLatencySec();
    const prev = this.lastLoggedLatencySec;
    if (Math.abs(latencySec - prev) < LATENCY_CHANGE_LOG_SEC) return;
    const first = prev < 0;
    // Recorded even when not logged, so a later move off a normal value still
    // reads as a change rather than as a first observation.
    this.lastLoggedLatencySec = latencySec;
    if (latencySec <= 0.02 && first) return;  // normal wired output, nothing to say

    const ol = (ctx as { outputLatency?: number }).outputLatency;
    const from = first ? '' : `(was ${(prev * 1000).toFixed(0)}ms) `;
    this._log(
      `output latency ${(latencySec * 1000).toFixed(0)}ms ${from}`
      + `(outLatency=${typeof ol === 'number' ? ol.toFixed(3) : 'n/a'}s baseLatency=${ctx.baseLatency?.toFixed(3) ?? 'n/a'}s) `
      + `— playhead compensated`,
    );
  }

  /**
   * How far the audio device trails the context clock, in seconds, or null when
   * the browser doesn't report it.
   *
   * `ctx.currentTime` advances on the render thread whether or not the hardware
   * is pulling the buffers we hand it, and the playhead is derived from it — so
   * a device that stalls or starts slowly shows up as a cursor marching
   * normally across silence. `getOutputTimestamp().contextTime` is the position
   * actually played out, so the gap between the two is the one measurement that
   * separates "the decoder was slow" from "the audio device was".
   */
  private _renderLagSec(): number | null {
    const ctx = this.ctx as (AudioContext & { getOutputTimestamp?: () => AudioTimestamp }) | null;
    if (!ctx || typeof ctx.getOutputTimestamp !== 'function') return null;
    let ts: AudioTimestamp;
    try { ts = ctx.getOutputTimestamp(); } catch { return null; }
    const played = ts?.contextTime;
    if (typeof played !== 'number' || !isFinite(played)) return null;
    return ctx.currentTime - played;
  }

  /**
   * Arm a one-shot check, run shortly after the first chunk should have become
   * audible, that the device is really consuming what was scheduled.
   *
   * Silent in the normal case. It exists for the report it is named after: a
   * long delay before sound while the playhead advanced on schedule — which the
   * existing logs cannot distinguish from a healthy play, since every one of
   * them (first-chunk latency, underruns) measures the decode/schedule side and
   * that side was fine.
   */
  private _armRenderCheck(firstCtxStart: number, myPlayId: number): void {
    if (this.renderCheckTimer !== null) clearTimeout(this.renderCheckTimer);
    const ctx = this.ctx;
    if (!ctx) return;
    const expectedLatency = this._outputLatencySec();
    const dueInSec = firstCtxStart - ctx.currentTime + expectedLatency + RENDER_CHECK_MARGIN_SEC;
    this.renderCheckTimer = setTimeout(() => {
      this.renderCheckTimer = null;
      if (this.playId !== myPlayId || !this.ctx) return;
      const lag = this._renderLagSec();
      if (lag === null) return;
      const behindSec = lag - expectedLatency;
      if (behindSec < RENDER_LAG_ALERT_SEC) return;
      this._log(
        `audio device ${(behindSec * 1000).toFixed(0)}ms behind the clock `
        + `(played out to ${(this.ctx.currentTime - lag).toFixed(3)}s, ctx at ${this.ctx.currentTime.toFixed(3)}s, `
        + `reported latency ${(expectedLatency * 1000).toFixed(0)}ms) `
        + `— sound is late but the playhead is not`,
        'error',
      );
    }, Math.max(0, dueInSec * 1000));
  }

  /**
   * @param compensated true (default) → the audible position, for the playhead.
   *   false → the scheduled position, for resuming playback (see getResumeTime).
   */
  private _computeMediaTime(compensated = true): number {
    if (!this.ctx || !this.isPlayingState) {
      // Not playing: return the last known position. Both cursors are kept in
      // sync by play() (set to startSec), _cancelPlayback() and seek() so this is
      // correct whether we're paused, between play() and first sample, or at rest.
      return compensated ? this.pausedAt : this.pausedAtSched;
    }
    // Subtract the band-pass filter's group delay AND the audio output latency so
    // the playhead reflects what's emerging from the speakers, not what's been
    // scheduled. Both are 0 when inactive/unreported.
    const lagSec = compensated ? this.filterGraph.getDelaySec() + this._outputLatencySec() : 0;
    const elapsedCtx = this.ctx.currentTime - this.playStartCtx - lagSec;
    if (elapsedCtx < 0) return this.playStartMedia;
    const t = Math.min(this.playStartMedia + elapsedCtx * this.playbackSpeed, this.timeline.duration);
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
    // Snapshot both positions before stopping: the audible one for the playhead,
    // the scheduled one for a resume (see getResumeTime).
    this.pausedAt = this._computeMediaTime();
    this.pausedAtSched = this._computeMediaTime(false);
    // Drop the end bound only AFTER the snapshots above (which clamp to it).
    // Clearing it here makes `endSec !== null` mean exactly "a bounded play is
    // in flight", which is what clearEndSec() keys off. play() re-arms it, and
    // setPlaybackSpeed() reads it before restarting.
    this.endSec = null;
    this.endBoundCommitted = false;

    // Increment playId — all async loops holding a stale id will exit
    this.playId++;

    if (this.slowDecodeTimer !== null) {
      clearInterval(this.slowDecodeTimer);
      this.slowDecodeTimer = null;
    }
    if (this.renderCheckTimer !== null) {
      clearTimeout(this.renderCheckTimer);
      this.renderCheckTimer = null;
    }
    if (this.latencyProbeTimer !== null) {
      clearTimeout(this.latencyProbeTimer);
      this.latencyProbeTimer = null;
    }
    this._stopClockDriftMonitor();

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

  /**
   * Async loop that fetches PCM chunks from Rust and schedules AudioBufferSourceNodes.
   *
   * @param continueFromCtx when set, this is a *continuation* of a play already in
   *   flight (see clearEndSec): open the stream at schedCursor rather than the
   *   play's start, and butt the first chunk against this ctx time instead of
   *   anchoring a new time origin. The media↔ctx mapping established by the
   *   original play() stays valid, so the playhead needs no adjustment.
   */
  private async _prefetchLoop(myPlayId: number, continueFromCtx?: number): Promise<void> {
    if (!this.ctx || !this.filePath) return;
    const myEndBoundEpoch = this.endBoundEpoch;
    const ctx = this.ctx;
    const path = this.filePath;
    const ch = this.fileChannels;
    const sr = this.fileSampleRate;
    const speed = this.playbackSpeed;
    const stretching = speed !== 1.0;
    const chunkFrames = Math.floor(CHUNK_DURATION_SEC * sr);

    // Open the Rust PcmStream at the playback start position (or, for a
    // continuation, at the point the in-flight audio runs out). The cursor is a
    // DISPLAY position; the span it falls in says where in the file to open.
    const openAt = continueFromCtx !== undefined ? this.schedCursor : this.playStartMedia;
    // A continuation whose resume point is already at/past the end has nothing to
    // schedule (the cleared selection ended at the end of the timeline) — let the
    // audio still in flight play out and end naturally.
    if (continueFromCtx !== undefined && openAt >= this.timeline.duration) {
      await this._endAfterQueueDrains(myPlayId, myEndBoundEpoch);
      return;
    }
    const spans = this.timeline.spans;
    let spanIdx = this.timeline.spanIndexAtDisplay(openAt);

    // Opens a stream at a source position and installs it as the active one.
    // Returns null on failure (callers below decide how fatal that is).
    const openStreamAt = async (srcSec: number) => {
      let h;
      try {
        h = await startPcmStream(path, srcSec);
      } catch (err) {
        if (this.playId !== myPlayId) return null;
        console.error('AudioEngine: startPcmStream failed', err);
        this._log(`startPcmStream failed: ${String(err)}`, 'error');
        return null;
      }
      if (this.playId !== myPlayId) {
        closePcmStream(h.stream_id).catch(() => {});
        return null;
      }
      this._log(
        `stream opened id=${h.stream_id} at ${srcSec.toFixed(3)}s sr=${h.sample_rate} ch=${h.channels} total_frames=${h.total_frames}`,
      );
      this.streamId = h.stream_id;
      return h;
    };

    let handle = await openStreamAt(this._srcInSpan(spanIdx, openAt));
    if (!handle) {
      if (this.playId !== myPlayId) return;
      if (continueFromCtx !== undefined) {
        // The already-scheduled audio is fine; only the extension failed. Cutting
        // it off would be worse than the missing continuation.
        await this._endAfterQueueDrains(myPlayId, myEndBoundEpoch);
        return;
      }
      // Fully tear down so the UI doesn't stay stuck in the "buffering" state
      // and the user can try another file cleanly. Without this, isBuffering
      // remains true on the React side and subsequent plays inherit the hang.
      this._cancelPlayback();
      this.callbacks.onPaused();
      return;
    }

    // `expectedNextCtxStart` tracks where the next chunk should be scheduled.
    // It's anchored when the first chunk arrives (or, for a continuation, seeded
    // from the tail of the audio already scheduled) and advances by each chunk's
    // duration. It is NOT reset when a span boundary swaps the stream — that's
    // exactly what makes the join inaudible.
    let expectedNextCtxStart = continueFromCtx ?? 0;
    let reachedEnd = false;
    // Set when the branch below reports an underrun, cleared once the chunk that
    // closes the gap is scheduled, so onBufferRecovered fires exactly once per
    // underrun. `underruns` only gates the debug log (see there).
    let underrunPending = false;
    let underruns = 0;

    // Generation token: if a concurrent play() cancels this stream and opens a new
    // one, `this.streamId` will no longer match `handle.stream_id`.  Combined with
    // the `this.playId === myPlayId` guard, this prevents a stale loop from
    // scheduling onto the wrong generation's queue or state (finding 1).
    while (this.playId === myPlayId && this.streamId === handle.stream_id) {
      // Also pruned here, not only on the rAF tick: rAF stops when the window
      // is hidden or minimized while Web Audio plays straight on, and that is
      // precisely a long unattended play — the case the queue grows worst in.
      this._pruneQueue();

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

      // Never read past the end of the current span — the samples after it
      // belong to time this timeline doesn't show. Rounded (not floored) so a
      // span whose length isn't a whole number of frames doesn't shed its last
      // partial frame and leave a sub-millisecond hole at every join.
      const span = spans[spanIdx];
      const framesLeftInSpan = Math.round((span.srcEnd - this._srcInSpan(spanIdx, this.schedCursor)) * sr);

      // Fetch the next chunk from Rust. A span with nothing left doesn't get a
      // read at all — it goes straight to the advance below.
      let chunk;
      if (framesLeftInSpan > 0) {
        try {
          chunk = await readPcmChunk(handle.stream_id, Math.min(chunkFrames, framesLeftInSpan));
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
      } else {
        chunk = null;
      }

      if (!chunk || chunk.frames_read === 0) {
        // This span is spent. If another follows, swap streams and keep going:
        // the ctx clock is untouched, so the next span's first sample lands
        // immediately after this one's last. The swap happens HORIZON_SEC ahead
        // of the playhead, so its latency is never heard.
        if (spanIdx + 1 < spans.length) {
          const gapSec = spans[spanIdx + 1].srcStart - spans[spanIdx].srcEnd;
          spanIdx++;
          this.schedCursor = spans[spanIdx].dispStart;

          // Short gap: read past it on the stream we already have and throw the
          // samples away. Reopening means a container seek, which on a long
          // compressed file costs far more than decoding a second or two — and
          // a dense subset can put a join every frame, so paying a seek at each
          // one is what would make playback stutter.
          if (gapSec <= GAP_READ_THROUGH_SEC) {
            let framesToSkip = Math.round(gapSec * sr);
            let readThrough = true;
            while (framesToSkip > 0) {
              let skipped;
              try {
                skipped = await readPcmChunk(handle.stream_id, Math.min(chunkFrames, framesToSkip));
              } catch {
                readThrough = false;
                break;
              }
              if (this.playId !== myPlayId) return;
              if (skipped.frames_read === 0) { readThrough = false; break; }
              framesToSkip -= skipped.frames_read;
            }
            // The stream now sits at the next span's start — same generation,
            // nothing to reopen.
            if (readThrough) continue;
          }

          const prevStreamId = handle.stream_id;
          this.streamId = null;
          closePcmStream(prevStreamId).catch(() => {});
          const next = await openStreamAt(spans[spanIdx].srcStart);
          if (!next) {
            // Can't reach the next span. Let the scheduled audio drain and stop
            // there rather than cutting it off mid-word.
            reachedEnd = true;
            break;
          }
          handle = next;
          continue;
        }

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
              naturalCtxEnd: ctxEnd,
            });
            expectedNextCtxStart = ctxEnd;
          }
        }
        break;
      }

      // Where this chunk sits on the DISPLAY axis. Rust reports its position in
      // the file; the span it was read from converts that back. Clamped to the
      // span's own start so a decoder that hands back a frame or two of seek
      // margin can't place the chunk before the span begins.
      const chunkMediaStart = Math.max(
        spans[spanIdx].dispStart,
        this._dispInSpan(spanIdx, chunk.start_frame / sr),
      );
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
      //
      // The shift must be the FULL displacement of the chunk — the overrun plus
      // the lead time added on top of it. Compensating only the overrun (as this
      // did) leaves the playhead permanently UNDERRUN_LEAD_SEC ahead of the
      // audio, and since nothing re-anchors mid-play the error accumulates: a
      // dozen underruns is a quarter second of sound trailing the cursor, which
      // is exactly the window annotations get placed in.
      if (expectedNextCtxStart < ctx.currentTime) {
        const resumeAt = ctx.currentTime + UNDERRUN_LEAD_SEC;
        // Only the first underrun of a play is logged: every _log() is a React
        // state update in the host window, and a storm of them during a play
        // that is already failing to keep up would make it worse.
        if (underruns === 0) {
          this._log(`buffer underrun at ${chunkMediaStart.toFixed(3)}s `
            + `(${((ctx.currentTime - expectedNextCtxStart) * 1000).toFixed(0)}ms late) — further ones not logged`);
        }
        underruns++;
        this.playStartCtx += resumeAt - expectedNextCtxStart;
        expectedNextCtxStart = resumeAt;
        underrunPending = true;
        this.callbacks.onBufferUnderrun();
      }

      // ── Build deinterleaved input for this chunk ───────────────────────────
      const inputChannels = deinterleave(chunk.samples, inputFrames, ch);

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
      const naturalCtxEnd = ctxStart + outputDurationSec;
      let ctxEnd = naturalCtxEnd;

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
          this.endBoundCommitted = true;  // baked into the graph — clearEndSec() must restart
        } else if (chunkMediaStart >= this.endSec) {
          reachedEnd = true;
          this.endBoundCommitted = true;
          break;
        }
      }

      this.queue.push({ source, mediaStart: chunkMediaStart, mediaEnd: chunkMediaEnd, ctxStart, ctxEnd, naturalCtxEnd });
      expectedNextCtxStart = ctxEnd;
      this.schedCursor = chunkMediaEnd;
      this.chunksScheduled++;
      if (underrunPending) {
        underrunPending = false;
        this.callbacks.onBufferRecovered();
      }
      if (this.chunksScheduled === 1) {
        const elapsedMs = Math.round(performance.now() - this.playStartedAtMs);
        this._log(`first chunk scheduled mediaStart=${chunkMediaStart.toFixed(3)}s in=${inputFrames}f out=${outputFrames}f (${elapsedMs}ms after play)`);
        this._armRenderCheck(ctxStart, myPlayId);
        this._armLatencyProbe(ctxStart, myPlayId);
        this._startClockDriftMonitor(myPlayId);
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
    if (reachedEnd) await this._endAfterQueueDrains(myPlayId, myEndBoundEpoch);
  }

  /**
   * Wait for the last scheduled node to finish, then tear down and report EOF.
   * Both guards must still hold on the far side of the wait: `playId` for a
   * pause/seek/new play, and `endBoundEpoch` for a clearEndSec() that landed
   * mid-wait — the end bound this call was going to report has been dropped and
   * a continuation loop is now scheduling past it.
   */
  private async _endAfterQueueDrains(myPlayId: number, myEndBoundEpoch: number): Promise<void> {
    if (this.playId !== myPlayId || this.endBoundEpoch !== myEndBoundEpoch) return;
    const lastCtxEnd = this.queue.length > 0
      ? this.queue[this.queue.length - 1].ctxEnd
      : this.ctx?.currentTime ?? 0;
    const waitMs = Math.max(0, (lastCtxEnd - (this.ctx?.currentTime ?? 0) + this._outputLatencySec()) * 1000 + 50);
    await sleep(waitMs);
    if (this.playId !== myPlayId || this.endBoundEpoch !== myEndBoundEpoch) return;
    this._cancelPlayback();
    this.callbacks.onEnded();
  }

  // ── PCM cache ────────────────────────────────────────────────────────────────

  /**
   * Pre-decode and cache the PCM for [startSec, endSec] so subsequent plays in
   * that range start instantaneously. Delegates to PcmCache; see preloadRange there.
   *
   * Times are display positions. A range crossing a cut isn't one contiguous run
   * of file samples, so there's nothing the cache could hold for it — those plays
   * go through the streaming path, which handles the join.
   */
  async preloadRange(startSec: number, endSec: number): Promise<void> {
    if (!this.filePath) return;
    const src = this._sourceRangeWithinOneSpan(startSec, endSec);
    if (!src) return;
    await this.pcmCache.preloadRange(this.filePath, this.fileChannels, this.fileSampleRate, src.start, src.end);
  }

  /**
   * Schedule a cached PCM slice directly, bypassing all Rust IPC.
   * Called from play() on a cache hit. Only used at speed=1.0 (see play()).
   * Does NOT start the rAF loop — caller does that.
   *
   * `dispStart`/`dispEnd` are the play's own display bounds. The slice's own
   * startSec/endSec are file positions, which under a subset are a different
   * number for the same audio — the queue and the scheduling cursor are in
   * display time like everything else here.
   */
  private _playCached(slice: PcmCacheSlice, dispStart: number, dispEnd: number, myPlayId: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const sr = this.fileSampleRate;
    const { entry, startFrame, frameCount } = slice;

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
      mediaStart: dispStart,
      mediaEnd: dispEnd,
      ctxStart: this.playStartCtx,
      ctxEnd,
      // The slice IS the selection: nothing was truncated, so there's nothing for
      // clearEndSec() to reclaim here. Its cover is the rest of the slice.
      naturalCtxEnd: ctxEnd,
    });
    this.schedCursor = dispEnd;
    this.chunksScheduled = 1;
    // Same check as the streamed path: a cache hit rules the decoder out
    // entirely, so a delay before sound here can only be the device.
    this._log(
      `cached slice scheduled ${Math.round(performance.now() - this.playStartedAtMs)}ms after play `
      + `— starts in ${((this.playStartCtx - ctx.currentTime) * 1000).toFixed(0)}ms of ctx time`,
    );
    this._armRenderCheck(this.playStartCtx, myPlayId);
    this._armLatencyProbe(this.playStartCtx, myPlayId);
    this._startClockDriftMonitor(myPlayId);
    // The cached slice covers exactly [startSec, endSec] and nothing follows it,
    // so the end bound is committed the moment it's scheduled.
    this.endBoundCommitted = true;

    // Fire onEnded after the buffer finishes playing. Add output latency so the
    // teardown (which snapshots pausedAt via _computeMediaTime) lands after the
    // audio is actually audible through endSec, not when it was merely scheduled.
    const waitMs = Math.max(0, (ctxEnd - ctx.currentTime + this._outputLatencySec()) * 1000 + 50);
    const myEndBoundEpoch = this.endBoundEpoch;
    setTimeout(() => {
      // Epoch guard: clearEndSec() may have dropped this end bound and started a
      // continuation loop that is scheduling past it (see clearEndSec).
      if (this.playId !== myPlayId || this.endBoundEpoch !== myEndBoundEpoch) return;
      this._cancelPlayback();
      this.callbacks.onEnded();
    }, waitMs);
  }

  /**
   * Drop queue entries whose audio has finished rendering, so their buffers can
   * be collected.
   *
   * Nothing used to leave this queue until the next play() or pause(), and each
   * entry pins a one-second AudioBuffer through its source node: ~21 MB for
   * every minute of uninterrupted 44.1 kHz stereo playback, over a gigabyte an
   * hour. On the hours-long recordings this app is built for that is enough GC
   * pressure to stall the main thread — which freezes the rAF-driven playhead
   * while the audio thread plays straight on.
   *
   * A node is safe to drop once ctx.currentTime has passed its ctxEnd: the
   * render clock runs ahead of what is audible, so every sample it will ever
   * produce has already been handed downstream. The tail entry is always kept —
   * clearEndSec() and _endAfterQueueDrains() both read it.
   */
  private _pruneQueue(): void {
    if (!this.ctx || this.queue.length < 2) return;
    const now = this.ctx.currentTime;
    let done = 0;
    while (done < this.queue.length - 1 && this.queue[done].ctxEnd <= now) done++;
    if (done === 0) return;
    for (let i = 0; i < done; i++) {
      try { this.queue[i].source.disconnect(); } catch { /* already detached */ }
    }
    this.queue.splice(0, done);
  }

  /** rAF loop: drives onTimeUpdate and fires onPlaying once audio starts. */
  private _rafLoop(myPlayId: number): void {
    const frame = () => {
      // Stale play() — stop ticking (also stopped by _cancelPlayback, which
      // bumps playId; this guards a frame that slips through in between).
      if (this.playId !== myPlayId) { this._raf.stop(); return; }

      if (this.ctx) {
        this._pruneQueue();
        // Sampled per frame so a device change *during* a play is caught, not
        // just one seen at the next play().
        this._logOutputLatency();
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
