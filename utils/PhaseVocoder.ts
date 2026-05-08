/**
 * Streaming phase vocoder for pitch-preserving time-stretching.
 *
 * Replaces SoundTouchJS's WSOLA. Phase vocoders sound smoother than WSOLA
 * on tonal/sustained content (animal calls, ambience, insect buzz), which
 * matches what gets annotated in this app. Tradeoff: transients are
 * slightly softened ("phasiness"), most noticeable on sharp clicks/taps
 * at speedup. Acceptable for the target dataset.
 *
 * Algorithm — classic Dudas/Lippe phase vocoder:
 *   1. Sliding analysis window (Hann), FFT each frame
 *   2. Per bin: principal-arg phase difference from previous frame, derive
 *      instantaneous frequency
 *   3. Re-accumulate synthesis phase at synthesisHop spacing
 *   4. IFFT, window, overlap-add into output accumulator
 *   5. Emit synthesisHop samples per frame as finalised output
 *
 * speed > 1 → synthesisHop < analysisHop (output shorter)
 * speed < 1 → synthesisHop > analysisHop (output longer)
 *
 * fftSize=2048, analysisHop=128 → at speed=0.25 synthesisHop=512 (= N/4),
 * still satisfies COLA for Hann² windowing. At speed=4 synthesisHop=32
 * (deep overlap, very smooth).
 */

const TWO_PI = 2 * Math.PI;
const FFT_SIZE = 2048;
const ANALYSIS_HOP = 128;
const NUM_BINS = FFT_SIZE / 2 + 1;

class FFT {
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly bitRev: Uint32Array;

  constructor(private readonly n: number) {
    const half = n / 2;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const a = -TWO_PI * i / n;
      this.cosTable[i] = Math.cos(a);
      this.sinTable[i] = Math.sin(a);
    }
    const bits = Math.log2(n) | 0;
    this.bitRev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.bitRev[i] = r;
    }
  }

  /** In-place radix-2 forward FFT. */
  forward(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.bitRev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const tableStep = n / size;
      for (let i = 0; i < n; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const tre = re[j + half] * c - im[j + half] * s;
          const tim = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
          k += tableStep;
        }
      }
    }
  }

  /** In-place inverse FFT via the conj trick: IFFT(X) = conj(FFT(conj(X)))/N. */
  inverse(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }
}

interface ChannelState {
  inputRing: Float32Array;        // size FFT_SIZE, oldest sample at inputWriteIdx
  inputWriteIdx: number;
  outAccum: Float32Array;         // size FFT_SIZE, OLA accumulator for unfinalised output
  prevInputPhase: Float32Array;   // size NUM_BINS
  synthesisPhase: Float32Array;   // size NUM_BINS
  outputQueue: Float32Array[];    // chunks of finalised output samples awaiting pull
  outputQueueOffset: number;      // already-consumed samples from outputQueue[0]
}

export class PhaseVocoder {
  private readonly fft = new FFT(FFT_SIZE);
  private readonly window: Float32Array;
  private readonly channels: ChannelState[] = [];
  private synthesisHop = ANALYSIS_HOP;
  private speed = 1;
  /** Samples remaining until the next analysis frame. Starts at FFT_SIZE so we
   *  wait until the ring is full before the first frame. After that, ANALYSIS_HOP. */
  private samplesUntilFrame = FFT_SIZE;
  /** Finalised samples awaiting pull, shared count across channels (lockstep). */
  private outputAvailable = 0;
  private readonly re = new Float32Array(FFT_SIZE);
  private readonly im = new Float32Array(FFT_SIZE);

  constructor(private readonly numChannels: number) {
    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(TWO_PI * i / FFT_SIZE));
    }
    for (let c = 0; c < numChannels; c++) {
      this.channels.push(this.makeChannelState());
    }
  }

  private makeChannelState(): ChannelState {
    return {
      inputRing: new Float32Array(FFT_SIZE),
      inputWriteIdx: 0,
      outAccum: new Float32Array(FFT_SIZE),
      prevInputPhase: new Float32Array(NUM_BINS),
      synthesisPhase: new Float32Array(NUM_BINS),
      outputQueue: [],
      outputQueueOffset: 0,
    };
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.synthesisHop = Math.max(1, Math.round(ANALYSIS_HOP / speed));
  }

  /** Reset all internal state. Call at the start of every play(). */
  reset(): void {
    this.samplesUntilFrame = FFT_SIZE;
    this.outputAvailable = 0;
    for (let c = 0; c < this.numChannels; c++) {
      this.channels[c] = this.makeChannelState();
    }
  }

  /** Push input samples (deinterleaved per-channel). Triggers analysis frames as the ring fills. */
  pushInput(input: Float32Array[], numFrames: number): void {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < this.numChannels; c++) {
        const st = this.channels[c];
        st.inputRing[st.inputWriteIdx] = input[c][i];
        st.inputWriteIdx = (st.inputWriteIdx + 1) % FFT_SIZE;
      }
      this.samplesUntilFrame--;
      if (this.samplesUntilFrame <= 0) {
        this.processFrame();
        this.samplesUntilFrame = ANALYSIS_HOP;
      }
    }
  }

  /**
   * Drain remaining unfinalised output by treating the current outAccum as final.
   * Call once at end-of-stream so the ~fftSize-tail of the signal isn't lost.
   * After flush(), the vocoder must be reset() before reuse.
   */
  flush(): void {
    for (let c = 0; c < this.numChannels; c++) {
      const st = this.channels[c];
      // Whatever's in outAccum represents the trailing OLA sum. No more frames
      // will arrive to add to it, so emit the whole buffer as final samples.
      const tail = new Float32Array(st.outAccum);
      this.applyGain(tail);
      st.outputQueue.push(tail);
      st.outAccum.fill(0);
    }
    this.outputAvailable += FFT_SIZE;
  }

  /** Number of finalised output frames currently available to pull. */
  available(): number {
    return this.outputAvailable;
  }

  /**
   * Pull up to `maxFrames` frames into the provided output Float32Arrays.
   * Returns the number of frames actually written.
   */
  pullOutput(output: Float32Array[], maxFrames: number): number {
    const want = Math.min(maxFrames, this.outputAvailable);
    if (want === 0) return 0;
    for (let c = 0; c < this.numChannels; c++) {
      const st = this.channels[c];
      let written = 0;
      while (written < want) {
        const head = st.outputQueue[0];
        const headRemaining = head.length - st.outputQueueOffset;
        const take = Math.min(headRemaining, want - written);
        output[c].set(head.subarray(st.outputQueueOffset, st.outputQueueOffset + take), written);
        st.outputQueueOffset += take;
        written += take;
        if (st.outputQueueOffset >= head.length) {
          st.outputQueue.shift();
          st.outputQueueOffset = 0;
        }
      }
    }
    this.outputAvailable -= want;
    return want;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Steady-state output gain from the double-window OLA. Compensate per-emit. */
  private applyGain(samples: Float32Array): void {
    // ∑ hann²[n - m·H] over m equals 0.375·N/H in steady state (Hann²).
    const gainComp = this.synthesisHop / (0.375 * FFT_SIZE);
    for (let i = 0; i < samples.length; i++) samples[i] *= gainComp;
  }

  private processFrame(): void {
    const Ha = ANALYSIS_HOP;
    const Hs = this.synthesisHop;

    for (let c = 0; c < this.numChannels; c++) {
      const st = this.channels[c];

      // ── Analysis: read fftSize samples (oldest → newest) and apply window ──
      const start = st.inputWriteIdx;
      for (let i = 0; i < FFT_SIZE; i++) {
        this.re[i] = st.inputRing[(start + i) % FFT_SIZE] * this.window[i];
        this.im[i] = 0;
      }
      this.fft.forward(this.re, this.im);

      // ── Per-bin phase advance, accumulate synthesis phase, reconstruct ─────
      for (let k = 0; k < NUM_BINS; k++) {
        const xr = this.re[k];
        const xi = this.im[k];
        const mag = Math.sqrt(xr * xr + xi * xi);
        const phase = Math.atan2(xi, xr);

        // Expected phase advance for bin k over Ha samples
        const expected = TWO_PI * k * Ha / FFT_SIZE;
        let dphi = phase - st.prevInputPhase[k] - expected;
        // Wrap to (-π, π]
        dphi = dphi - TWO_PI * Math.round(dphi / TWO_PI);
        // Total advance per Ha samples → scale to Hs samples
        const synthAdvance = (expected + dphi) * (Hs / Ha);
        st.synthesisPhase[k] += synthAdvance;
        st.prevInputPhase[k] = phase;

        this.re[k] = mag * Math.cos(st.synthesisPhase[k]);
        this.im[k] = mag * Math.sin(st.synthesisPhase[k]);
      }
      // Hermitian symmetry for the negative-frequency half
      for (let k = 1; k < FFT_SIZE / 2; k++) {
        this.re[FFT_SIZE - k] = this.re[k];
        this.im[FFT_SIZE - k] = -this.im[k];
      }
      this.im[0] = 0;
      this.im[FFT_SIZE / 2] = 0;

      this.fft.inverse(this.re, this.im);

      // ── OLA: window the synthesis frame and add into outAccum ─────────────
      for (let i = 0; i < FFT_SIZE; i++) {
        st.outAccum[i] += this.re[i] * this.window[i];
      }

      // Emit the first synthesisHop samples (no further frames will touch them)
      const emit = new Float32Array(Hs);
      emit.set(st.outAccum.subarray(0, Hs));
      this.applyGain(emit);
      st.outputQueue.push(emit);

      // Shift outAccum left by Hs and zero the freed tail
      st.outAccum.copyWithin(0, Hs);
      st.outAccum.fill(0, FFT_SIZE - Hs);
    }

    this.outputAvailable += Hs;
  }
}
