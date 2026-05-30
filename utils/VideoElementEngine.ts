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
  /** Debug log sink — same signature as addLog in AnnotationWindow. */
  onDebugLog?: (msg: string) => void;
}

// TypeScript doesn't ship requestVideoFrameCallback types yet.
interface VideoFrameCallbackMetadata {
  presentedFrames: number;
  mediaTime: number;
  expectedDisplayTime: DOMHighResTimeStamp;
}
type VideoFrameCallback = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void;
interface RVFCElement extends HTMLVideoElement {
  requestVideoFrameCallback(cb: VideoFrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}

export class VideoElementEngine {
  private el: HTMLVideoElement | null = null;
  private readonly cb: VideoElementEngineCallbacks;
  private endSec: number | null = null;
  private raf = 0;
  private speed = 1;
  private gain = 1;          // 0..1 (the element can't boost above unity)
  private playingState = false;

  // ── Freeze detector state ───────────────────────────────────────────────
  private _lastSeenTime = -1;
  private _stuckFrames = 0;

  // ── Stall event listener cleanup fns ────────────────────────────────────
  private _stallCleanup: (() => void)[] = [];

  // ── requestVideoFrameCallback tracking ──────────────────────────────────
  private _rvfcHandle = 0;
  private _rvfcLastPresentedFrames = 0;
  private _rvfcLastLogAt = 0;

  constructor(cb: VideoElementEngineCallbacks) {
    this.cb = cb;
  }

  /** Bind (or unbind, with null) the React-owned element. Idempotent. */
  attach(el: HTMLVideoElement | null): void {
    if (this.el === el) return;
    if (this.el) {
      this._stopRaf();
      this._removeStallListeners();
      this._stopRvfc();
    }
    this.el = el;
    this.playingState = false;
    if (el) {
      el.playbackRate = this.speed;
      el.volume = this.gain;
      this._addStallListeners(el);
      this._startRvfc(el);
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
    this._lastSeenTime = -1;
    this._stuckFrames = 0;
    if (Math.abs(el.currentTime - startSec) > 0.01) el.currentTime = startSec;
    el.playbackRate = this.speed;
    el.volume = this.gain;        // 0 silences; `muted` is owned by React (VideoPlayer)
    this.playingState = true;
    this.cb.onDebugLog?.(
      `[video-el] play start=${startSec.toFixed(3)} end=${endSec?.toFixed(3) ?? 'eof'} ` +
      `readyState=${el.readyState} networkState=${el.networkState} ` +
      `buffered=${this._bufferedDesc(el)}`,
    );
    void el.play().catch((err) => {
      this.cb.onDebugLog?.(`[video-el] play() rejected: ${err instanceof Error ? err.message : String(err)}`);
    });
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
    this._removeStallListeners();
    this._stopRvfc();
    this.el = null;
    this.playingState = false;
  }

  // ── Stall event listeners ───────────────────────────────────────────────

  private _addStallListeners(el: HTMLVideoElement): void {
    const log = (msg: string) => this.cb.onDebugLog?.(msg);

    const onWaiting = () => log(
      `[video-el] WAITING (buffering stall) — ` +
      `readyState=${el.readyState} networkState=${el.networkState} ` +
      `buffered=${this._bufferedDesc(el)} currentTime=${el.currentTime.toFixed(3)}`,
    );
    const onStalled = () => log(
      `[video-el] STALLED (network stalled) — ` +
      `readyState=${el.readyState} networkState=${el.networkState} ` +
      `buffered=${this._bufferedDesc(el)}`,
    );
    const onSuspend = () => log(
      `[video-el] SUSPEND (browser paused loading) — readyState=${el.readyState}`,
    );
    const onCanPlay = () => log(
      `[video-el] canplay — buffered=${this._bufferedDesc(el)}`,
    );
    const onError = () => {
      const err = el.error;
      log(`[video-el] ERROR code=${err?.code ?? '?'} msg=${err?.message ?? 'unknown'}`);
    };

    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('suspend', onSuspend);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('error', onError);

    this._stallCleanup = [
      () => el.removeEventListener('waiting', onWaiting),
      () => el.removeEventListener('stalled', onStalled),
      () => el.removeEventListener('suspend', onSuspend),
      () => el.removeEventListener('canplay', onCanPlay),
      () => el.removeEventListener('error', onError),
    ];
  }

  private _removeStallListeners(): void {
    for (const fn of this._stallCleanup) fn();
    this._stallCleanup = [];
  }

  // ── requestVideoFrameCallback ───────────────────────────────────────────

  private _startRvfc(el: HTMLVideoElement): void {
    if (!('requestVideoFrameCallback' in el)) {
      this.cb.onDebugLog?.('[video-el] requestVideoFrameCallback: NOT supported in this WebView');
      return;
    }
    this.cb.onDebugLog?.('[video-el] requestVideoFrameCallback: supported — starting frame counter');
    this._rvfcLastPresentedFrames = 0;
    this._rvfcLastLogAt = performance.now();

    const rvfcEl = el as RVFCElement;
    const tick: VideoFrameCallback = (now, metadata) => {
      if (this.el !== el) return; // element was detached
      const elapsed = now - this._rvfcLastLogAt;
      if (elapsed >= 2000) {
        const delta = metadata.presentedFrames - this._rvfcLastPresentedFrames;
        const fps = (delta / elapsed * 1000).toFixed(1);
        this.cb.onDebugLog?.(
          `[video-el] RVFC presentedFrames=${metadata.presentedFrames} ` +
          `(+${delta} in ${elapsed.toFixed(0)}ms ≈ ${fps}fps) ` +
          `currentTime=${el.currentTime.toFixed(3)}`,
        );
        this._rvfcLastPresentedFrames = metadata.presentedFrames;
        this._rvfcLastLogAt = now;
      }
      this._rvfcHandle = rvfcEl.requestVideoFrameCallback(tick);
    };
    this._rvfcHandle = rvfcEl.requestVideoFrameCallback(tick);
  }

  private _stopRvfc(): void {
    if (this._rvfcHandle && this.el && 'cancelVideoFrameCallback' in this.el) {
      (this.el as RVFCElement).cancelVideoFrameCallback(this._rvfcHandle);
    }
    this._rvfcHandle = 0;
  }

  // ── RAF playhead loop with freeze detector ──────────────────────────────

  private _startRaf(): void {
    this._stopRaf();
    const tick = () => {
      const el = this.el;
      if (!el || !this.playingState) return;
      const t = el.currentTime;
      this.cb.onTimeUpdate(t);

      // Freeze detector: log once when currentTime stops advancing for ~1s.
      if (Math.abs(t - this._lastSeenTime) < 0.001) {
        this._stuckFrames++;
        if (this._stuckFrames === 60) {
          this.cb.onDebugLog?.(
            `[video-el] FREEZE DETECTED: currentTime=${t.toFixed(3)} unchanged for ~1s — ` +
            `readyState=${el.readyState} networkState=${el.networkState} ` +
            `buffered=${this._bufferedDesc(el)} paused=${el.paused} ended=${el.ended}`,
          );
        }
      } else {
        if (this._stuckFrames >= 60) {
          this.cb.onDebugLog?.(
            `[video-el] freeze cleared — currentTime now ${t.toFixed(3)} ` +
            `(was stuck for ${this._stuckFrames} frames)`,
          );
        }
        this._stuckFrames = 0;
        this._lastSeenTime = t;
      }

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

  // ── Helpers ─────────────────────────────────────────────────────────────

  private _bufferedDesc(el: HTMLVideoElement): string {
    const b = el.buffered;
    if (!b.length) return 'none';
    const ranges = [];
    for (let i = 0; i < b.length; i++) {
      ranges.push(`${b.start(i).toFixed(2)}-${b.end(i).toFixed(2)}`);
    }
    return ranges.join(',');
  }
}
