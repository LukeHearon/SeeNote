/**
 * Diagnostics for the audio output clock: everything AudioEngine logs about
 * output latency, the device lagging the context clock, the context clock
 * drifting from wall time during a play, and what the clocks did while idle.
 * None of it affects playback; it exists so the debug log can tell "the decoder
 * was slow" from "the audio device was". Split out of AudioEngine, which only
 * calls the lifecycle hooks below.
 */

export interface ClockDiagnosticsHost {
  ctx(): AudioContext | null;
  /** The engine's current play generation; a timer armed for an older one is stale. */
  playId(): number;
  /** Band-pass filter group delay currently compensated, for the log lines. */
  filterDelaySec(): number;
  log(msg: string, type?: 'info' | 'error'): void;
}

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

/** Shortest stop worth an idle-gap line (see _logIdleGap). Below this the two
 *  clocks can't have parted by anything that matters. */
const IDLE_GAP_LOG_MIN_SEC = 1;

/** How often the playback clock monitor samples (see _startClockDriftMonitor).
 *  Short enough that a one-second selection still produces a line. */
const CLOCK_DRIFT_SAMPLE_MS = 500;

/** Wall time that must pass before the monitor's first line: below this the
 *  numbers are dominated by the sample interval itself. */
const CLOCK_DRIFT_FIRST_LOG_SEC = 0.9;

/** Additional drift or timer overshoot (seconds) beyond the last logged figure
 *  worth another line. */
const CLOCK_DRIFT_LOG_STEP_SEC = 0.1;

/**
 * Output latency the context reports: `outputLatency` (full path to the
 * output device), else `baseLatency` (context → audio subsystem), else 0.
 * AudioEngine subtracts it from the playhead.
 */
export function outputLatencySec(ctx: AudioContext | null): number {
  if (!ctx) return 0;
  const ol = (ctx as { outputLatency?: number }).outputLatency;
  if (typeof ol === 'number' && isFinite(ol) && ol > 0) return ol;
  const bl = ctx.baseLatency;
  if (typeof bl === 'number' && isFinite(bl) && bl > 0) return bl;
  return 0;
}

export class AudioClockDiagnostics {
  private renderCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private latencyProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last output latency reported to the log, so a change is only logged once.
   *  Negative until the first sample. */
  private lastLoggedLatencySec = -1;
  /** ctx.currentTime and wall time as of the last stop, so the next play can
   *  measure what the two clocks did while nothing was playing. Null when
   *  there is no gap to measure (fresh context, or already reported). */
  private idleCtxStamp: number | null = null;
  private idleWallStampMs = 0;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private driftCtxOrigin = 0;
  private driftWallOriginMs = 0;
  private driftLastLoggedSec = 0;
  /** Output device rate as of the most recent context creation; null until known. */
  private deviceSampleRate: number | null = null;

  constructor(private readonly host: ClockDiagnosticsHost) {}

  /** A context was just created: note its device rate; its clock has no idle gap. */
  onContextCreated(deviceRate: number): void {
    this.recordDeviceSampleRate(deviceRate);
    this.idleCtxStamp = null;
  }

  /** A context was dropped: an idle figure spanning two clocks means nothing. */
  onContextDropped(): void {
    this.idleCtxStamp = null;
  }

  /** The first audio of a play is scheduled at `firstCtxStart`. */
  onFirstAudio(firstCtxStart: number, myPlayId: number): void {
    this.armRenderCheck(firstCtxStart, myPlayId);
    this.armLatencyProbe(firstCtxStart, myPlayId);
    this.startDriftMonitor(myPlayId);
  }

  /**
   * Playback stopped. `stoppedSomething` is false for the cancel play() makes
   * before every play: a stamp taken there would overwrite the one from the
   * stop we want to measure across.
   */
  onStop(stoppedSomething: boolean): void {
    this.clearTimers();
    // Stamp both clocks at the stop. The next play compares them: the drift
    // monitor re-origins per play, so a context clock that gains on wall time
    // *between* plays is invisible to it.
    if (!stoppedSomething) return;
    const ctx = this.host.ctx();
    if (ctx && ctx.state === 'running') {
      this.idleCtxStamp = ctx.currentTime;
      this.idleWallStampMs = performance.now();
    } else {
      this.idleCtxStamp = null;
    }
  }

  clearTimers(): void {
    if (this.renderCheckTimer !== null) clearTimeout(this.renderCheckTimer);
    if (this.latencyProbeTimer !== null) clearTimeout(this.latencyProbeTimer);
    this.renderCheckTimer = null;
    this.latencyProbeTimer = null;
    this.stopDriftMonitor();
  }

  /**
   * Note the output device's rate, taken from the context we just opened at it,
   * and log a change since the last one. `rate` is 0 when we deliberately opened
   * at the file's rate instead (the A/B flag), in which case the context tells
   * us nothing about the device and the last reading stands.
   *
   * This used to be a *probe*: a throwaway AudioContext opened with no
   * `sampleRate` option, read, and closed, whose rate was then named explicitly
   * when constructing the real one. That is two AudioContexts alive at once —
   * `close()` is async and was not awaited (it cannot be; the real context has
   * to be constructed inside the user gesture) — so CoreAudio was picking an IO
   * configuration for our real context while a second one was still tearing
   * down. A race at exactly the moment the output path's buffering is decided,
   * whose outcome then holds for the whole life of the context, is a strong
   * candidate for the intermittent "playhead runs ahead of the sound" reports:
   * bad for every play in one session, fine for every play in the next.
   *
   * Constructing with no options gets the same rate with no second context, so
   * there is nothing left to race.
   */
  recordDeviceSampleRate(rate: number): void {
    if (rate <= 0) return;
    const prev = this.deviceSampleRate;
    this.deviceSampleRate = rate;
    if (prev !== null && prev !== rate) {
      this.host.log(`output device rate changed ${prev}Hz -> ${rate}Hz`);
    }
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
  private armLatencyProbe(firstCtxStart: number, myPlayId: number): void {
    if (this.latencyProbeTimer !== null) clearTimeout(this.latencyProbeTimer);
    const ctx = this.host.ctx();
    if (!ctx) return;
    const dueInSec = firstCtxStart - ctx.currentTime + LATENCY_PROBE_DELAY_SEC;
    this.latencyProbeTimer = setTimeout(() => {
      this.latencyProbeTimer = null;
      const c = this.host.ctx() as (AudioContext & { outputLatency?: number }) | null;
      if (this.host.playId() !== myPlayId || !c) return;
      const ol = typeof c.outputLatency === 'number' ? `${(c.outputLatency * 1000).toFixed(1)}ms` : 'n/a';
      const bl = typeof c.baseLatency === 'number' ? `${(c.baseLatency * 1000).toFixed(1)}ms` : 'n/a';
      const measured = this.renderLagSec();
      const dev = this.deviceSampleRate ?? 0;
      // An exact 0 means getOutputTimestamp() handed back contextTime ===
      // currentTime, which WKWebView does whatever the device is doing. Marked,
      // because read as a measurement it says "no real latency" and is the one
      // reading here that cannot say that.
      const measuredStr = measured === null ? 'unavailable'
        : measured === 0 ? '0.0ms (contextTime===currentTime; not a real reading)'
        : `${(measured * 1000).toFixed(1)}ms`;
      this.host.log(
        `latency probe: reported out=${ol} base=${bl} — `
        + `measured(getOutputTimestamp)=${measuredStr} — `
        + `compensating ${(outputLatencySec(c) * 1000).toFixed(1)}ms out `
        + `+ ${(this.host.filterDelaySec() * 1000).toFixed(1)}ms filter — `
        + `ctx.sr=${c.sampleRate} device.sr=${dev || 'unknown'}`,
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
  private startDriftMonitor(myPlayId: number): void {
    this.stopDriftMonitor();
    const ctx = this.host.ctx();
    if (!ctx) return;
    this.driftCtxOrigin = ctx.currentTime;
    this.driftWallOriginMs = performance.now();
    this.driftLastLoggedSec = 0;
    let firstLogged = false;
    let lastTickMs = this.driftWallOriginMs;
    let maxOvershootSec = 0;
    this.driftTimer = setInterval(() => {
      const cur = this.host.ctx();
      if (this.host.playId() !== myPlayId || !cur) { this.stopDriftMonitor(); return; }
      const nowMs = performance.now();
      const overshootSec = (nowMs - lastTickMs - CLOCK_DRIFT_SAMPLE_MS) / 1000;
      lastTickMs = nowMs;
      if (overshootSec > maxOvershootSec) maxOvershootSec = overshootSec;
      const ctxElapsed = cur.currentTime - this.driftCtxOrigin;
      const wallElapsed = (nowMs - this.driftWallOriginMs) / 1000;
      if (wallElapsed <= 0) return;
      const excess = ctxElapsed - wallElapsed;
      const worst = Math.max(Math.abs(excess), maxOvershootSec);
      const worthLogging = worst >= this.driftLastLoggedSec + CLOCK_DRIFT_LOG_STEP_SEC;
      if (!worthLogging && (firstLogged || wallElapsed < CLOCK_DRIFT_FIRST_LOG_SEC)) return;
      firstLogged = true;
      if (worthLogging) this.driftLastLoggedSec = worst;
      this.host.log(
        `clocks: ctx +${ctxElapsed.toFixed(3)}s vs wall +${wallElapsed.toFixed(3)}s `
        + `— ctx ${excess >= 0 ? 'ahead' : 'behind'} by ${Math.abs(excess * 1000).toFixed(0)}ms `
        + `— event loop worst overshoot ${(maxOvershootSec * 1000).toFixed(0)}ms `
        + `— filter delay ${(this.host.filterDelaySec() * 1000).toFixed(0)}ms`,
      );
    }, CLOCK_DRIFT_SAMPLE_MS);
  }

  stopDriftMonitor(): void {
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
  logOutputLatency(): void {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const latencySec = outputLatencySec(ctx);
    const prev = this.lastLoggedLatencySec;
    if (Math.abs(latencySec - prev) < LATENCY_CHANGE_LOG_SEC) return;
    const first = prev < 0;
    // Recorded even when not logged, so a later move off a normal value still
    // reads as a change rather than as a first observation.
    this.lastLoggedLatencySec = latencySec;
    if (latencySec <= 0.02 && first) return;  // normal wired output, nothing to say

    const ol = (ctx as { outputLatency?: number }).outputLatency;
    const from = first ? '' : `(was ${(prev * 1000).toFixed(0)}ms) `;
    this.host.log(
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
  private renderLagSec(): number | null {
    const ctx = this.host.ctx() as (AudioContext & { getOutputTimestamp?: () => AudioTimestamp }) | null;
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
  private armRenderCheck(firstCtxStart: number, myPlayId: number): void {
    if (this.renderCheckTimer !== null) clearTimeout(this.renderCheckTimer);
    const ctx = this.host.ctx();
    if (!ctx) return;
    const expectedLatency = outputLatencySec(ctx);
    const dueInSec = firstCtxStart - ctx.currentTime + expectedLatency + RENDER_CHECK_MARGIN_SEC;
    this.renderCheckTimer = setTimeout(() => {
      this.renderCheckTimer = null;
      const cur = this.host.ctx();
      if (this.host.playId() !== myPlayId || !cur) return;
      const lag = this.renderLagSec();
      if (lag === null) return;
      const behindSec = lag - expectedLatency;
      if (behindSec < RENDER_LAG_ALERT_SEC) return;
      this.host.log(
        `audio device ${(behindSec * 1000).toFixed(0)}ms behind the clock `
        + `(played out to ${(cur.currentTime - lag).toFixed(3)}s, ctx at ${cur.currentTime.toFixed(3)}s, `
        + `reported latency ${(expectedLatency * 1000).toFixed(0)}ms) `
        + `— sound is late but the playhead is not`,
        'error',
      );
    }, Math.max(0, dueInSec * 1000));
  }

  /**
   * Report what the two clocks did while nothing was playing.
   *
   * Everything is scheduled against `ctx.currentTime` — `playStartCtx =
   * ctx.currentTime + START_MARGIN_SEC`, and the same anchor in the prefetch
   * loop. That clock advances as WebKit's render thread produces quanta, not as
   * the device plays them.
   *
   * Measured across a 135.7s idle with the app in the background, a context
   * left running came back 9.0s SHORT of wall time, and the plays that followed
   * were about a second late and stayed late until the context was rebuilt. So
   * the renderer falls behind the device while idle rather than running ahead
   * of it. The same measurement in the foreground (9.0s stopped) is clean to
   * 1ms. Within a play both clocks advance together, which is why the drift
   * monitor — it re-origins at every play — never sees any of this.
   *
   * A negative figure on a context that was suspended while idle is expected
   * and harmless: a suspended clock is frozen for the length of the gap.
   */
  logIdleGap(): void {
    const ctxStamp = this.idleCtxStamp;
    this.idleCtxStamp = null;
    const ctx = this.host.ctx();
    if (ctxStamp === null || !ctx) return;
    const wallElapsed = (performance.now() - this.idleWallStampMs) / 1000;
    if (wallElapsed < IDLE_GAP_LOG_MIN_SEC) return;
    const ctxElapsed = ctx.currentTime - ctxStamp;
    const excess = ctxElapsed - wallElapsed;
    this.host.log(
      `idle gap: stopped for ${wallElapsed.toFixed(1)}s — ctx +${ctxElapsed.toFixed(3)}s `
      + `(${excess >= 0 ? 'gained' : 'frozen for'} ${Math.abs(excess * 1000).toFixed(0)}ms) `
      + `— ctx.state=${ctx.state}`,
    );
  }
}
