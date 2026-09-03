/**
 * audioLoopback — measure the real speaker→ear delay with the microphone.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * AudioEngine's playhead is compensated by `ctx.outputLatency`: the reported
 * distance between scheduling a sample and hearing it. On WKWebView/macOS that
 * figure is ~2ms and `getOutputTimestamp()` — the API that could contradict it —
 * returns `contextTime === currentTime`, which is not a reading at all. So when
 * the playhead visibly runs ahead of the sound, nothing in the app can say by
 * how much, or even that it is happening: every stage we *can* measure (decode,
 * IPC, scheduling, ctx-vs-wall drift) comes back clean, because all of them sit
 * upstream of the gap.
 *
 * This closes the loop the only way a web page can: emit a click at a known
 * context time, record it back through the microphone, and find it. That single
 * number is the one thing the existing instrumentation cannot produce.
 *
 * ── What the number means ─────────────────────────────────────────────────────
 * It is a ROUND TRIP: output latency + acoustic flight + input latency. It is
 * therefore an UPPER BOUND on the output latency we care about, and overstates
 * it by however long the capture path takes (typically 10–40ms; the ~1ms of air
 * between the speaker and the mic is noise by comparison).
 *
 * That is fine for the question being asked. We are separating "a few tens of
 * ms, i.e. the reported 2ms is roughly honest and the drift is elsewhere" from
 * "half a second, i.e. `outputLatency` is off by 100x". A ±40ms bias does not
 * blur those two together. Do not read it as a calibration constant to subtract
 * from the playhead — it is a diagnostic, not a correction.
 *
 * ── Method ────────────────────────────────────────────────────────────────────
 * Record continuously; emit N clicks at known context times, spaced far enough
 * apart that a room's reverberant tail from one has died before the next. Map
 * each recorded block back to context time using the `ctx.currentTime` observed
 * when it was delivered, then find each click's ONSET (first crossing of a
 * fraction of its own peak) rather than its peak — a reflective room smears the
 * peak later, but the leading edge is the direct path. Report the median across
 * clicks, plus the spread, so a single bad detection is visible rather than
 * silently averaged in.
 *
 * The context is created exactly the way AudioEngine creates its own — `new
 * AudioContext()` with no `sampleRate` option, so it opens at the device rate —
 * so what this measures is representative of the playback path.
 *
 * ── Microphone permission ─────────────────────────────────────────────────────
 * Dev-only, and `tauri dev` runs an unbundled binary, so macOS attributes the
 * request to the parent process: the prompt says *Terminal* (or your IDE) wants
 * microphone access, and it is Terminal's entry in System Settings → Privacy
 * that has to be on. There is deliberately no NSMicrophoneUsageDescription in
 * the bundle — this never runs in a release build, and shipping a microphone
 * usage string for a feature that isn't there would be a lie to the user.
 */

/** Frequency of the click burst. High enough to be sharp and to sit above room
 *  rumble, low enough to survive a laptop speaker and a laptop mic. */
const CLICK_FREQ_HZ = 3000;
/** Burst length. A couple of cycles: long enough to carry energy, short enough
 *  that its own envelope doesn't blur the onset we're looking for. */
const CLICK_DUR_SEC = 0.003;
/** Peak amplitude of the burst, before the output gain. Loud enough to clear a
 *  quiet room's noise floor, quiet enough not to startle. */
const CLICK_AMPLITUDE = 0.6;
/** Gap between clicks. Longer than any plausible round trip plus the time a
 *  small room takes to go quiet, so each search window holds exactly one click. */
const CLICK_SPACING_SEC = 0.6;
/** Lead time before the first click, covering mic warm-up and giving the noise
 *  floor estimate something to work with. */
const LEAD_IN_SEC = 0.4;
/** Trailing record time after the last click. Also the largest round trip this
 *  can detect — a delay longer than this falls outside the recording. */
const TAIL_SEC = 1.5;
/** ScriptProcessor block size. 1024 frames is ~21ms at 48k: the granularity of
 *  the recording→context-time mapping, and so the floor on this measurement's
 *  precision. Smaller blocks risk dropouts under a busy main thread, which is
 *  the exact condition we may be measuring under. */
const BLOCK_SIZE = 1024;
/** Onset threshold, as a fraction of the click's own detected peak. */
const ONSET_RATIO = 0.25;
/** Envelope smoothing window. Shorter than the click, so it doesn't drag the
 *  onset later; long enough to stop a single noisy sample triggering it. */
const ENVELOPE_SMOOTH_SEC = 0.0005;
/** A detection must clear the noise floor by this factor to be believed. */
const MIN_SNR = 4;

export interface LoopbackResult {
  /** Median round-trip delay across all detected clicks, in seconds. */
  roundTripSec: number;
  /** Per-click round trips, in seconds, in emission order. */
  perClickSec: number[];
  /** Max − min across detections: large spread means distrust the median. */
  spreadSec: number;
  /** How many clicks were emitted and how many were found. */
  clicksEmitted: number;
  clicksDetected: number;
  /** What `ctx.outputLatency` claimed during the measurement, for comparison —
   *  the whole point is the gap between this and roundTripSec. */
  reportedOutputLatencySec: number;
  reportedBaseLatencySec: number;
  sampleRate: number;
  /** RMS of the lead-in, i.e. the room + mic noise floor. */
  noiseFloor: number;
}

/** Build a Hann-windowed tone burst — the click we look for. */
export function buildClick(sampleRate: number): Float32Array {
  const n = Math.max(1, Math.round(CLICK_DUR_SEC * sampleRate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Hann window: no discontinuity at either edge, so the burst has no click
    // of its own on top of the one we're generating.
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1 || 1)));
    out[i] = CLICK_AMPLITUDE * w * Math.sin((2 * Math.PI * CLICK_FREQ_HZ * i) / sampleRate);
  }
  return out;
}

/**
 * Rectified, box-smoothed envelope of a signal. Smoothing is causal-symmetric
 * (centred), so it does not shift the onset in either direction.
 */
export function envelope(x: Float32Array, sampleRate: number): Float32Array {
  const half = Math.max(1, Math.round((ENVELOPE_SMOOTH_SEC * sampleRate) / 2));
  const out = new Float32Array(x.length);
  // Running sum over |x| across a window of (2*half+1), clamped at the edges.
  let sum = 0;
  for (let i = 0; i < Math.min(half + 1, x.length); i++) sum += Math.abs(x[i]);
  let lo = 0;
  let hi = Math.min(half, x.length - 1);
  for (let i = 0; i < x.length; i++) {
    out[i] = sum / (hi - lo + 1);
    const nextHi = Math.min(i + 1 + half, x.length - 1);
    if (nextHi > hi) { sum += Math.abs(x[nextHi]); hi = nextHi; }
    const nextLo = i + 1 - half;
    if (nextLo > lo) { sum -= Math.abs(x[lo]); lo = nextLo; }
  }
  return out;
}

/** RMS of a slice. Used for the noise floor and the SNR gate. */
export function rms(x: Float32Array, from = 0, to = x.length): number {
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (b - a));
}

/**
 * Index of the click's onset within `[from, to)` of an envelope, or null if
 * nothing in the window clears `noiseFloor * MIN_SNR`.
 *
 * Onset, not peak: in a reflective room the strongest sample can be a reflection
 * arriving milliseconds after the direct sound, and it is the direct sound that
 * dates the click. So we find the window's peak only to set a scale, then walk
 * back to the first sample that reached a fraction of it.
 */
export function findOnset(
  env: Float32Array,
  from: number,
  to: number,
  noiseFloor: number,
): number | null {
  const a = Math.max(0, from);
  const b = Math.min(env.length, to);
  if (b <= a) return null;
  let peak = 0;
  let peakIdx = a;
  for (let i = a; i < b; i++) {
    if (env[i] > peak) { peak = env[i]; peakIdx = i; }
  }
  if (peak < noiseFloor * MIN_SNR) return null;
  const threshold = peak * ONSET_RATIO;
  for (let i = a; i <= peakIdx; i++) {
    if (env[i] >= threshold) return i;
  }
  return peakIdx;
}

/** Median of a non-empty list. Returns NaN for an empty one. */
export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((p, q) => p - q);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Locate each click in a recording and return its round-trip delay.
 *
 * Pure, so the detection can be tested without a microphone: `recording` is the
 * captured signal, `captureCtxTime(i)` maps a sample index in it to the context
 * time at which that sample was captured, and `clickCtxTimes` are the context
 * times the clicks were scheduled for.
 */
export function detectRoundTrips(
  recording: Float32Array,
  sampleRate: number,
  captureCtxTime: (sampleIndex: number) => number,
  clickCtxTimes: number[],
  noiseFloorFrames: number,
): { perClickSec: number[]; noiseFloor: number } {
  const env = envelope(recording, sampleRate);
  const noiseFloor = Math.max(rms(env, 0, noiseFloorFrames), 1e-7);
  const perClickSec: number[] = [];

  // Each click owns the window running from its own emission to just before the
  // next one's, mapped back through the capture clock. A round trip longer than
  // the spacing would land in the next click's window; that would show up as a
  // wild spread rather than a plausible wrong answer.
  for (let c = 0; c < clickCtxTimes.length; c++) {
    const startCtx = clickCtxTimes[c];
    const endCtx = c + 1 < clickCtxTimes.length
      ? clickCtxTimes[c + 1]
      : startCtx + TAIL_SEC;
    const from = ctxTimeToIndex(startCtx, recording.length, captureCtxTime);
    const to = ctxTimeToIndex(endCtx, recording.length, captureCtxTime);
    const onset = findOnset(env, from, to, noiseFloor);
    if (onset === null) continue;
    perClickSec.push(captureCtxTime(onset) - startCtx);
  }
  return { perClickSec, noiseFloor };
}

/**
 * First sample index whose capture time is at or after `ctxTime`. Binary search:
 * `captureCtxTime` is monotonically increasing by construction (it is derived
 * from a frame counter plus a per-block context timestamp).
 */
function ctxTimeToIndex(
  ctxTime: number,
  length: number,
  captureCtxTime: (i: number) => number,
): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (captureCtxTime(mid) < ctxTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface LoopbackOptions {
  /** Number of clicks to emit. More clicks, more robust median, longer test. */
  clicks?: number;
  /** Called with progress messages so the caller can show what's happening. */
  onProgress?: (msg: string) => void;
}

/**
 * Run the measurement. Requires microphone permission and audible speakers —
 * on headphones the mic hears nothing and this reports no detections.
 *
 * Throws with a readable message if the mic is unavailable or no click could be
 * found; the caller is expected to surface that text.
 */
export async function measureLoopbackLatency(
  opts: LoopbackOptions = {},
): Promise<LoopbackResult> {
  const clicks = opts.clicks ?? 5;
  const progress = opts.onProgress ?? (() => {});

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unavailable in this webview');
  }

  progress('requesting microphone…');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Every bit of processing here would distort the timing we're measuring:
      // echo cancellation exists specifically to remove the speaker signal from
      // the mic, which is the entire signal we are looking for.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    throw new Error(`microphone unavailable: ${String(err)}`);
  }

  // Created the same way AudioEngine creates its own — no `sampleRate` option,
  // so it opens at the device rate — so the path being measured is the path
  // playback actually uses.
  const ctx = new AudioContext();
  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    ctx.close().catch(() => {});
  };

  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const sr = ctx.sampleRate;

    // ── Capture path: mic → ScriptProcessor → muted destination ──────────────
    // A ScriptProcessor rather than an AudioWorklet: the worklet needs a
    // separately-served module URL, and this is a dev-only diagnostic where the
    // deprecation costs nothing. It must be connected to the destination or it
    // is not pulled at all, hence the zero gain.
    const micSource = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(BLOCK_SIZE, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    const blocks: Float32Array[] = [];
    // Context time observed as each block was delivered. The block holds audio
    // captured over roughly the preceding BLOCK_SIZE frames, which is what
    // `captureCtxTime` below assumes.
    const blockCtxTimes: number[] = [];
    proc.onaudioprocess = (e: AudioProcessingEvent) => {
      blockCtxTimes.push(ctx.currentTime);
      blocks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    micSource.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);

    // ── Emit the clicks ──────────────────────────────────────────────────────
    const clickBuf = ctx.createBuffer(1, Math.round(CLICK_DUR_SEC * sr), sr);
    clickBuf.getChannelData(0).set(buildClick(sr));

    const t0 = ctx.currentTime + LEAD_IN_SEC;
    const clickCtxTimes: number[] = [];
    for (let i = 0; i < clicks; i++) {
      const when = t0 + i * CLICK_SPACING_SEC;
      const src = ctx.createBufferSource();
      src.buffer = clickBuf;
      src.connect(ctx.destination);
      src.start(when);
      clickCtxTimes.push(when);
    }

    const totalSec = LEAD_IN_SEC + clicks * CLICK_SPACING_SEC + TAIL_SEC;
    progress(`recording ${totalSec.toFixed(1)}s — ${clicks} clicks, keep the room quiet`);
    // Read the reported latency mid-run, while the device is actually streaming:
    // before the first click it can still be the pre-start default.
    await new Promise<void>(r => setTimeout(r, (LEAD_IN_SEC + 0.1) * 1000));
    const reportedOutputLatencySec =
      typeof (ctx as { outputLatency?: number }).outputLatency === 'number'
        ? (ctx as { outputLatency?: number }).outputLatency! : 0;
    const reportedBaseLatencySec = ctx.baseLatency ?? 0;
    await new Promise<void>(r => setTimeout(r, (totalSec - LEAD_IN_SEC - 0.1) * 1000));

    proc.onaudioprocess = null;
    micSource.disconnect();
    proc.disconnect();

    if (blocks.length === 0) throw new Error('no audio captured from the microphone');

    // ── Flatten and build the sample-index → capture-time mapping ─────────────
    const recording = new Float32Array(blocks.length * BLOCK_SIZE);
    for (let b = 0; b < blocks.length; b++) recording.set(blocks[b], b * BLOCK_SIZE);
    // A block delivered at context time T holds the BLOCK_SIZE frames captured
    // just before it, so sample i of block b was captured at
    // blockCtxTimes[b] - blockDur + (i / sr). The unknown input latency shifts
    // every one of these later by the same amount, which is exactly the bias
    // this function's doc comment declares.
    const blockDur = BLOCK_SIZE / sr;
    const captureCtxTime = (i: number): number => {
      const b = Math.min(blocks.length - 1, Math.max(0, Math.floor(i / BLOCK_SIZE)));
      return blockCtxTimes[b] - blockDur + (i - b * BLOCK_SIZE) / sr;
    };

    const noiseFloorFrames = Math.min(
      recording.length,
      Math.max(BLOCK_SIZE, Math.round(LEAD_IN_SEC * 0.5 * sr)),
    );
    const { perClickSec, noiseFloor } = detectRoundTrips(
      recording, sr, captureCtxTime, clickCtxTimes, noiseFloorFrames,
    );

    if (perClickSec.length === 0) {
      throw new Error(
        'no clicks detected — are the speakers on and audible? '
        + '(on headphones the mic cannot hear the output)',
      );
    }

    return {
      roundTripSec: median(perClickSec),
      perClickSec,
      spreadSec: Math.max(...perClickSec) - Math.min(...perClickSec),
      clicksEmitted: clicks,
      clicksDetected: perClickSec.length,
      reportedOutputLatencySec,
      reportedBaseLatencySec,
      sampleRate: sr,
      noiseFloor,
    };
  } finally {
    cleanup();
  }
}

/** One-line summary of a result, for the debug log. */
export function formatLoopbackResult(r: LoopbackResult): string {
  const ms = (s: number) => `${(s * 1000).toFixed(0)}ms`;
  const unexplained = r.roundTripSec - r.reportedOutputLatencySec;
  return (
    `loopback: round trip ${ms(r.roundTripSec)} `
    + `(${r.clicksDetected}/${r.clicksEmitted} clicks, spread ${ms(r.spreadSec)}) `
    + `vs reported out=${ms(r.reportedOutputLatencySec)} base=${ms(r.reportedBaseLatencySec)} `
    + `— ${ms(unexplained)} unaccounted for (includes input latency) `
    + `— sr=${r.sampleRate}`
  );
}
