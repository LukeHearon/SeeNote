/**
 * Playback transport backed by a browser <video> element playing its OWN audio
 * track. Used by Fast mode (and Mixed before a selection), where we trade
 * spectrogram-accuracy for the element's flawless built-in A/V sync — the right
 * trade on machines that can't sustain the WebCodecs+canvas "High" path.
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
 * sample-accurate path (Off/High/Mixed-with-selection and all audio-only files).
 */
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

export class VideoElementEngine {
  private el: HTMLVideoElement | null = null;
  private readonly cb: VideoElementEngineCallbacks;
  private endSec: number | null = null;
  private raf = 0;
  private speed = 1;
  private gain = 1;          // 0..1 (the element can't boost above unity)
  private playingState = false;

  constructor(cb: VideoElementEngineCallbacks) {
    this.cb = cb;
  }

  /** Bind (or unbind, with null) the React-owned element. Idempotent. */
  attach(el: HTMLVideoElement | null): void {
    if (this.el === el) return;
    if (this.el) this._stopRaf();
    this.el = el;
    this.playingState = false;
    if (el) {
      el.playbackRate = this.speed;
      el.volume = this.gain;
    }
  }

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
    el.currentTime = Math.max(0, sec);
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
    this.el = null;
    this.playingState = false;
  }

  private _startRaf(): void {
    this._stopRaf();
    const tick = () => {
      const el = this.el;
      if (!el || !this.playingState) return;
      const t = el.currentTime;
      this.cb.onTimeUpdate(t);
      // Bounded play (a selection) or natural end → stop and report once.
      if ((this.endSec !== null && t >= this.endSec) || el.ended) {
        el.pause();
        this.playingState = false;
        this.raf = 0;
        this.cb.onEnded();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private _stopRaf(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
