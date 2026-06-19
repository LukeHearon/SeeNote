/**
 * BandPassFilterGraph — persistent Butterworth band-pass filter graph for
 * AudioEngine, plus async group-delay measurement.
 *
 * Sources connect to the input node. Audio splits into a dry path
 * (gain = 1-strength) and a wet path (8-pole HP → 8-pole LP → gain = strength).
 * Both paths join at the output node, which feeds the master gainNode. When no
 * filter is set, the dry path is at gain=1 and wet at gain=0 — transparent
 * passthrough.
 *
 * The wet path uses four cascaded biquads on each side, set to Butterworth Q
 * values for an 8th-order maximally flat response. -48 dB/oct rolloff is steep
 * enough that out-of-band content at full wet is effectively silent (one octave
 * outside the band lands around -51 dB). A single 2-pole biquad is too gentle
 * (-12 dB/oct) and even 4-pole leaves an audible halo, so we eat the extra
 * biquads.
 *
 * The cascaded biquads have non-trivial group delay (tens of ms near the
 * cutoffs). To preserve sample-for-sample sync between the playhead and the
 * audio, we (a) match that delay on the dry branch via a DelayNode so the
 * wet/dry mix is phase-coherent, and (b) expose the measured delay via
 * getDelaySec() so AudioEngine can subtract it from _computeMediaTime(). The
 * delay value is measured empirically by rendering an impulse through an
 * offline copy of the wet chain whenever the cutoffs change.
 */

import { BandPassFilter } from '../types';
import { clamp } from './helpers';

/**
 * Q values for an 8th-order Butterworth response from four cascaded biquads.
 * Pole-pair angles π/16, 3π/16, 5π/16, 7π/16 → Q = 1/(2 cos θ).
 */
const BUTTERWORTH_8_Q = [0.5097955, 0.6013372, 0.9000000, 2.5629154] as const;

/**
 * Create the cascaded biquad nodes for an 8th-order Butterworth band-pass:
 * four highpass stages followed by four lowpass stages, each with its
 * Butterworth Q. Frequencies are left at their defaults — callers set them
 * (the live graph via setValueAtTime in apply(); the offline measurement via
 * .frequency.value before rendering) — and callers also wire the chain into
 * their surrounding graph, since the endpoints differ. Used by both the live
 * filter graph and the offline group-delay measurement so the two stay
 * identical.
 */
function buildButterworthCascade(
  ctx: BaseAudioContext,
): { hp: BiquadFilterNode[]; lp: BiquadFilterNode[] } {
  const hp = BUTTERWORTH_8_Q.map(q => {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.Q.value = q;
    return f;
  });
  const lp = BUTTERWORTH_8_Q.map(q => {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = q;
    return f;
  });
  return { hp, lp };
}

export class BandPassFilterGraph {
  private ctx: AudioContext | null = null;
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
  /** Sample rate used to clamp cutoffs in apply(); set on each apply() call. */
  private _fileSampleRate = 44100;

  /**
   * Measured wet-chain group delay (seconds). AudioEngine reads this in
   * _computeMediaTime() for playhead compensation. Equals the old
   * _filterDelaySec exactly.
   */
  getDelaySec(): number {
    return this._filterDelaySec;
  }

  /**
   * Build the persistent filter graph. Returns the input/output nodes:
   * AudioEngine connects chunk source nodes to `input` and `output` to its
   * master gainNode. Reapplies the current filter settings (transparent if none).
   */
  build(ctx: AudioContext): { input: AudioNode; output: AudioNode } {
    this.ctx = ctx;
    this._filterIn = ctx.createGain();
    this._filterOut = ctx.createGain();
    this._filterDry = ctx.createGain();
    this._filterWet = ctx.createGain();
    // Max delay 0.5s is way more than any realistic biquad group delay.
    this._filterDryDelay = ctx.createDelay(0.5);

    // Frequencies are set by _applyToGraph() (called below) via setValueAtTime;
    // the cascade is built here with just Q + type.
    const { hp, lp } = buildButterworthCascade(ctx);
    this._filterHP = hp;
    this._filterLP = lp;

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

    this._applyToGraph();

    return { input: this._filterIn, output: this._filterOut };
  }

  teardown(): void {
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
    this.ctx = null;
  }

  /**
   * Apply a band-pass filter (or `null` to remove it) to the live graph. Sets
   * cutoffs/mix via setValueAtTime and triggers async delay measurement.
   */
  apply(filter: BandPassFilter | null, fileSampleRate: number): void {
    this.bandPassFilter = filter;
    this._fileSampleRate = fileSampleRate;
    this._applyToGraph();
  }

  private _applyToGraph(): void {
    if (!this.ctx || !this._filterDry || !this._filterWet
        || this._filterHP.length === 0 || this._filterLP.length === 0) return;
    const t = this.ctx.currentTime;
    if (this.bandPassFilter) {
      const { low, high, strength } = this.bandPassFilter;
      const safeLow = clamp(low, 20, this._fileSampleRate / 2 - 20);
      const safeHigh = clamp(high, safeLow + 20, this._fileSampleRate / 2 - 1);
      for (const hp of this._filterHP) hp.frequency.setValueAtTime(safeLow, t);
      for (const lp of this._filterLP) lp.frequency.setValueAtTime(safeHigh, t);
      const s = clamp(strength, 0, 1);
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
    const length = Math.ceil(0.5 * sampleRate);
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const impulseBuf = offline.createBuffer(1, length, sampleRate);
    impulseBuf.getChannelData(0)[0] = 1;
    const source = offline.createBufferSource();
    source.buffer = impulseBuf;

    // Same cascade as the live wet path; set cutoffs before rendering.
    const { hp, lp } = buildButterworthCascade(offline);
    for (const f of hp) f.frequency.value = low;
    for (const f of lp) f.frequency.value = high;

    let prev: AudioNode = source;
    for (const node of hp) { prev.connect(node); prev = node; }
    for (const node of lp) { prev.connect(node); prev = node; }
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
}
