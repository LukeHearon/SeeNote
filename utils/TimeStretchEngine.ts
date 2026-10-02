/**
 * TimeStretchEngine — pitch-preserving time-stretch for AudioEngine.
 *
 * Wraps the two stretch engines AudioEngine picks between based on speed:
 *   - speed < 1 (slowdown): streaming phase vocoder (utils/PhaseVocoder.ts).
 *     Smoother than WSOLA on tonal/sustained content at extreme slowdowns.
 *   - speed > 1 (speedup): SoundTouchJS (WSOLA). Preserves transient sharpness
 *     much better than a phase vocoder at speedup; phase vocoder smears clicks.
 *
 * Mono input stays mono (one output channel; Web Audio upmixes), stereo stays
 * stereo and >2-channel input is downmixed to mono. Output frame count differs
 * from input by `effectiveSpeed` (not necessarily the requested speed — the
 * phase vocoder's hop is an integer) but pitch is preserved.
 */

import { SoundTouch } from 'soundtouchjs';
import { PhaseVocoder, phaseVocoderEffectiveSpeed } from './PhaseVocoder';

export interface StretchResult {
  /** One array per output channel (1 for mono input, else 2). */
  channels: Float32Array[];
  outputFrames: number;
}

const EMPTY: StretchResult = { channels: [], outputFrames: 0 };

export class TimeStretchEngine {
  private playbackSpeed = 1.0;
  private _phaseVocoder: PhaseVocoder | null = null;
  /** Channel count the current _phaseVocoder was allocated for (PV's channel
   *  count is fixed at construction). Set when allocated, checked on reuse. */
  private _phaseVocoderChannels = 0;
  private _soundTouch: SoundTouch | null = null;
  /** Which engine the current play() is using; null when not stretching. */
  private _activeStretchEngine: 'pv' | 'st' | null = null;
  /** Frames fed to / pulled from SoundTouch since reset(), to size its tail. */
  private _stIn = 0;
  private _stOut = 0;
  /** True once the final chunk has been flushed; a second flush is a no-op. */
  private _flushed = false;

  /** Set the playback speed without (re)initialising the engines. */
  setSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  /**
   * The input-seconds-per-output-second ratio the active engine really
   * delivers. Equal to the requested speed except for the phase vocoder, whose
   * integer synthesis hop rounds it. Media-time math must use this, not the
   * requested speed, or the playhead drifts from the audio. Valid after reset().
   */
  get effectiveSpeed(): number {
    if (this._activeStretchEngine === 'pv') return phaseVocoderEffectiveSpeed(this.playbackSpeed);
    if (this._activeStretchEngine === 'st') return this.playbackSpeed;
    return 1;
  }

  /**
   * Re-init the appropriate stretch engine for a new play session.
   * Phase vocoder for slowdowns, SoundTouch (WSOLA) for speedups. Each engine
   * is allocated lazily and reset on every reset() so internal buffers start clean.
   * `inputChannelCount` is the file's channel count (the vocoder only processes
   * the channels that exist).
   */
  reset(inputChannelCount: number): void {
    this._flushed = false;
    this._stIn = 0;
    this._stOut = 0;
    if (this.playbackSpeed < 1.0) {
      const pvChannels = inputChannelCount === 2 ? 2 : 1;
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
  }

  /** Release all engine state. */
  dispose(): void {
    this._phaseVocoder = null;
    this._phaseVocoderChannels = 0;
    this._soundTouch = null;
    this._activeStretchEngine = null;
  }

  /**
   * Push deinterleaved input PCM through the active stretch engine and pull
   * whatever output frames are currently available.
   *
   * `isFinal` flushes the engine's held-back tail so the last audio before EOF
   * (or a selection end) isn't lost. It latches until reset(): the engine can't
   * continue a stream it has flushed, so a caller that keeps going afterwards
   * must reset() first.
   */
  stretch(inputChannels: Float32Array[], inputFrames: number, isFinal: boolean): StretchResult {
    if (this._activeStretchEngine === 'pv') return this._stretchPV(inputChannels, inputFrames, isFinal);
    if (this._activeStretchEngine === 'st') return this._stretchST(inputChannels, inputFrames, isFinal);
    return EMPTY;
  }

  private _stretchPV(inputChannels: Float32Array[], inputFrames: number, isFinal: boolean): StretchResult {
    const pv = this._phaseVocoder!;
    const numCh = inputChannels.length;

    if (inputFrames > 0) {
      let pvIn: Float32Array[];
      if (this._phaseVocoderChannels === 2 && numCh === 2) {
        pvIn = inputChannels;
      } else if (numCh === 1) {
        pvIn = [inputChannels[0]];
      } else {
        pvIn = [mixToMono(inputChannels, inputFrames)];
      }
      pv.pushInput(pvIn, inputFrames);
    }

    if (isFinal && !this._flushed) {
      this._flushed = true;
      pv.flush();
    }

    const outputFrames = pv.available();
    if (outputFrames === 0) return EMPTY;
    const channels = Array.from({ length: this._phaseVocoderChannels }, () => new Float32Array(outputFrames));
    pv.pullOutput(channels, outputFrames);
    return { channels, outputFrames };
  }

  private _stretchST(inputChannels: Float32Array[], inputFrames: number, isFinal: boolean): StretchResult {
    const st = this._soundTouch!;
    const numCh = inputChannels.length;
    const outMono = numCh !== 2;

    if (inputFrames > 0) {
      const stereoInput = new Float32Array(inputFrames * 2);
      if (numCh === 2) {
        const l = inputChannels[0];
        const r = inputChannels[1];
        for (let i = 0; i < inputFrames; i++) {
          stereoInput[i * 2] = l[i];
          stereoInput[i * 2 + 1] = r[i];
        }
      } else {
        const m = numCh === 1 ? inputChannels[0] : mixToMono(inputChannels, inputFrames);
        for (let i = 0; i < inputFrames; i++) {
          stereoInput[i * 2] = m[i];
          stereoInput[i * 2 + 1] = m[i];
        }
      }
      st.inputBuffer.putSamples(stereoInput, 0, inputFrames);
      this._stIn += inputFrames;
      st.process();
    }

    // WSOLA holds back up to a sequence-length of input it hasn't been able to
    // overlap yet, and SoundTouch has no flush. Feed it silence so that held
    // audio is processed, then keep only as many output frames as the real
    // input is worth — the silence's own output is dropped, not played.
    let limit = Infinity;
    if (isFinal && !this._flushed) {
      this._flushed = true;
      // sampleReq is the input WSOLA needs before it emits; not part of the
      // typed API, so fall back to a generous fixed amount.
      const req = (st.stretch as unknown as { sampleReq?: number }).sampleReq;
      const pad = (Number.isFinite(req) ? req! : 8192) + 64;
      st.inputBuffer.putSamples(new Float32Array(pad * 2), 0, pad);
      st.process();
      limit = Math.max(0, Math.round(this._stIn / this.playbackSpeed) - this._stOut);
    }

    const available = st.outputBuffer.frameCount;
    const outputFrames = Math.min(available, limit);
    if (outputFrames === 0) {
      if (available > 0) st.outputBuffer.clear();
      return EMPTY;
    }
    const stereoOutput = new Float32Array(outputFrames * 2);
    st.outputBuffer.receiveSamples(stereoOutput, outputFrames);
    if (available > outputFrames) st.outputBuffer.clear();
    this._stOut += outputFrames;
    const left = new Float32Array(outputFrames);
    if (outMono) {
      for (let i = 0; i < outputFrames; i++) left[i] = stereoOutput[i * 2];
      return { channels: [left], outputFrames };
    }
    const right = new Float32Array(outputFrames);
    for (let i = 0; i < outputFrames; i++) {
      left[i] = stereoOutput[i * 2];
      right[i] = stereoOutput[i * 2 + 1];
    }
    return { channels: [left, right], outputFrames };
  }
}

/** Average any number of channels into one new array. */
function mixToMono(channels: Float32Array[], frames: number): Float32Array {
  const mono = new Float32Array(frames);
  const n = channels.length;
  for (let c = 0; c < n; c++) {
    const ch = channels[c];
    for (let i = 0; i < frames; i++) mono[i] += ch[i];
  }
  const inv = 1 / n;
  for (let i = 0; i < frames; i++) mono[i] *= inv;
  return mono;
}
