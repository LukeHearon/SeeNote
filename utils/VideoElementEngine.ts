/**
 * Playback transport backed by a browser <video> element playing its OWN audio
 * track. Used by Fast mode (and Mixed before a selection), where we trade
 * spectrogram-accuracy for the element's flawless built-in A/V sync — the right
 * trade on machines that can't sustain the WebCodecs+canvas "Accurate" path.
 *
 * It deliberately mirrors the slice of {@link AudioEngine}'s interface that
 * AnnotationWindow's transport layer calls (play/pause/seek/getMediaTime/
 * setGain/setPlaybackSpeed/isPlaying + the onTimeUpdate/onPlaying/onPaused/
 * onEnded callbacks), so the orchestrator can hold either engine behind one
 * `transport` reference and never branch on which is active.
 *
 * The element is owned by React (rendered in VideoPlayer) and handed here via
 * attach(); this class never mounts or unmounts it.
 *
 * NOTE: this path violates the time-axis-synchrony invariant by design — the
 * audio is the element's own track (no band-pass filter, no pitch-preserving
 * slow-down; playbackRate changes pitch), and the playhead tracks the element's
 * coarse currentTime rather than sample-exact PCM. AudioEngine remains the only
 * sample-accurate path (Off/Accurate/Mixed-with-selection and all audio-only files).
 */
import { PlaybackTransport } from '../types';
import { RafTicker } from './rafTicker';
import { isLinux } from './platform';

/** How long (ms) the media clock must stay frozen while we still think we're
 *  playing before the Linux stall watchdog nudges the pipeline. Comfortably above
 *  a normal frame interval, below a user-noticeable hang. */
const STALL_TIMEOUT_MS = 1500;
/** Cap on watchdog recovery attempts per play() so a genuinely unrecoverable stall
 *  isn't hammered forever (reset once the clock advances again). */
const MAX_STALL_RECOVERIES = 4;
/** Beat (ms) to leave the element paused before re-playing during stall recovery.
 *  A same-tick pause/play doesn't unstick the pipeline; the brief gap does. */
const STALL_RECOVERY_REPLAY_MS = 150;

export interface VideoElementEngineCallbacks {
  /** Fires every animation frame while playing, and once on seek. */
  onTimeUpdate: (mediaTime: number) => void;
  /** Fires when playback begins (clears any buffering state). */
  onPlaying: () => void;
  /** Fires when playback is paused by pause(). */
  onPaused: () => void;
  /** Fires at the end of a bounded play (endSec) or natural EOF. Mirrors
   *  AudioEngine.onEnded: the orchestrator decides whether to loop/reset. */
  onEnded: () => void;
}

export class VideoElementEngine implements PlaybackTransport {
  private el: HTMLVideoElement | null = null;
  private readonly cb: VideoElementEngineCallbacks;
  private endSec: number | null = null;
  private readonly raf = new RafTicker();
  private speed = 1;
  private gain = 1;          // 0..1 (the element can't boost above unity)
  private playingState = false;
  /** A seek requested before the element was ready to seek (see seek()); applied
   *  on the next `canplay`. Null when nothing is pending. */
  private pendingSeek: number | null = null;
  // Linux stall-watchdog state (see _watchForStall). Tracks the last media time we
  // saw advance and when (wall clock), plus how many recovery nudges we've spent.
  private lastMediaTime = 0;
  private lastProgressAt = 0;
  private stallRecoveries = 0;
  private recovering = false;

  constructor(cb: VideoElementEngineCallbacks) {
    this.cb = cb;
  }

  /** Bind (or unbind, with null) the React-owned element. Idempotent. */
  attach(el: HTMLVideoElement | null): void {
    if (this.el === el) return;
    if (this.el) {
      this._stopRaf();
      this.el.removeEventListener('canplay', this._applyPendingSeek);
    }
    this.el = el;
    this.playingState = false;
    this.pendingSeek = null;
    this.recovering = false;
    if (el) {
      el.playbackRate = this.speed;
      el.volume = this.gain;
      // Applies a seek deferred during initial preroll (see seek()).
      el.addEventListener('canplay', this._applyPendingSeek);
    }
  }

  /** Apply a seek that arrived while the element was still prerolling. Bound arrow
   *  so add/removeEventListener see one stable identity. */
  private _applyPendingSeek = (): void => {
    const el = this.el;
    if (!el || this.pendingSeek === null) return;
    const target = this.pendingSeek;
    this.pendingSeek = null;
    el.currentTime = target;
    this.cb.onTimeUpdate(el.currentTime);
  };

  get isPlaying(): boolean {
    return this.playingState;
  }

  getMediaTime(): number {
    return this.el?.currentTime ?? 0;
  }

  /** Play from `startSec`; if `endSec` is given, stop and fire onEnded there. */
  play(startSec: number, endSec?: number): void {
    const el = this.el;
    if (!el) return;
    this.endSec = endSec ?? null;
    if (Math.abs(el.currentTime - startSec) > 0.01) el.currentTime = startSec;
    el.playbackRate = this.speed;
    el.volume = this.gain;        // 0 silences; `muted` is owned by React (VideoPlayer)
    this.playingState = true;
    this.lastMediaTime = el.currentTime;
    this.lastProgressAt = performance.now();
    this.stallRecoveries = 0;
    void el.play().catch(() => { /* play() can reject during teardown */ });
    this.cb.onPlaying();
    this._startRaf();
  }

  pause(): void {
    this.el?.pause();
    if (!this.playingState) return;
    this.playingState = false;
    this._stopRaf();
    this.cb.onPaused();
  }

  /** Move the playhead without changing the playing state. */
  seek(sec: number): void {
    const el = this.el;
    if (!el) return;
    const target = Math.max(0, sec);
    // Seeking while WebKitGTK's GStreamer pipeline is still in its initial preroll
    // (readyState < HAVE_FUTURE_DATA) permanently wedges it in Linux Fast mode: the
    // pipeline never issues the HTTP range request for the target byte offset, so
    // the element stalls forever. Defer such a seek until the element has buffered
    // enough to seek cleanly — `canplay` (readyState >= HAVE_FUTURE_DATA) then fires
    // and _applyPendingSeek runs it. Seeks from an already-playing/ready element
    // (the common case, and all seeks on macOS/Windows) go through immediately.
    // HAVE_FUTURE_DATA === 3.
    if (el.readyState < 3) {
      this.pendingSeek = target;
      this.cb.onTimeUpdate(target); // keep the UI playhead where the user dropped it
      return;
    }
    this.pendingSeek = null;
    el.currentTime = target;
    this.cb.onTimeUpdate(el.currentTime);
  }

  /** Gain 0..(clamped 1). Mirrors AudioEngine.setGain (which also accepts >1). */
  setGain(gain: number): void {
    this.gain = Math.max(0, Math.min(1, gain));
    if (this.el) this.el.volume = this.gain;
  }

  setPlaybackSpeed(speed: number): void {
    this.speed = speed;
    if (this.el) this.el.playbackRate = speed;
  }

  dispose(): void {
    this._stopRaf();
    if (this.el) this.el.removeEventListener('canplay', this._applyPendingSeek);
    this.el = null;
    this.playingState = false;
    this.pendingSeek = null;
    this.recovering = false;
  }

  private _startRaf(): void {
    this.raf.start(() => {
      const el = this.el;
      if (!el || !this.playingState) return;
      const t = el.currentTime;
      this.cb.onTimeUpdate(t);
      // Bounded play (a selection) or natural end → stop and report once.
      if ((this.endSec !== null && t >= this.endSec) || el.ended) {
        el.pause();
        this.playingState = false;
        this.raf.stop();
        this.cb.onEnded();
        return;
      }
      this._watchForStall(el, t);
    });
  }

  /** Recover from WebKitGTK's intermittent Linux Fast-mode pipeline stall: playback
   *  freezes a fraction of a second in even though the whole file is already buffered
   *  server-side, so it's a decoder/clock stall, not data starvation. When the media
   *  clock stops advancing while we still think we're playing, pause the element and
   *  re-play it after a short beat — the same thing that recovers it by hand. (An
   *  in-place flush-seek was tried and does NOT unstick it.) Linux-only (the stall
   *  doesn't occur on macOS/Windows) and capped per play() so an unrecoverable stall
   *  isn't hammered forever. */
  private _watchForStall(el: HTMLVideoElement, t: number): void {
    if (!isLinux) return;
    const now = performance.now();
    if (t > this.lastMediaTime + 1e-4) {
      this.lastMediaTime = t;
      this.lastProgressAt = now;
      this.stallRecoveries = 0;
      return;
    }
    // A deliberate pause, an in-flight seek, or our own in-flight recovery isn't a
    // stall to act on — don't count it against the stall timer.
    if (el.paused || el.seeking || this.recovering) {
      this.lastProgressAt = now;
      return;
    }
    if (now - this.lastProgressAt < STALL_TIMEOUT_MS) return;
    if (this.stallRecoveries >= MAX_STALL_RECOVERIES) return;
    this.stallRecoveries += 1;
    this.lastProgressAt = now;
    // Pause now, re-play after a brief gap (STALL_RECOVERY_REPLAY_MS). el.pause()
    // is the element's own pause, not this.pause() (which would tear down the RAF
    // loop and report onPaused) — we stay logically "playing" throughout.
    this.recovering = true;
    el.pause();
    setTimeout(() => {
      this.recovering = false;
      if (this.el === el && this.playingState && !el.ended) {
        this.lastProgressAt = performance.now();
        void el.play().catch(() => { /* transient reject during recovery is fine */ });
      }
    }, STALL_RECOVERY_REPLAY_MS);
  }

  private _stopRaf(): void {
    this.raf.stop();
  }
}
