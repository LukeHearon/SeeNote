/**
 * TimeStretchEngine — pitch-preserving time-stretch for AudioEngine.
 *
 * Wraps the two stretch engines AudioEngine picks between based on speed:
 *   - speed < 1 (slowdown): streaming phase vocoder (utils/PhaseVocoder.ts).
 *     Smoother than WSOLA on tonal/sustained content at extreme slowdowns.
 *   - speed > 1 (speedup): SoundTouchJS (WSOLA). Preserves transient sharpness
 *     much better than a phase vocoder at speedup; phase vocoder smears clicks.
 *
 * Both engines emit stereo: mono input is duplicated L=R and >2-channel input
 * is downmixed. Output frame count differs from input (≈ inputFrames / speed)
 * but pitch is preserved.
 */

import { SoundTouch } from 'soundtouchjs';
import { PhaseVocoder } from './PhaseVocoder';

export class TimeStretchEngine {
  private playbackSpeed = 1.0;
  private _phaseVocoder: PhaseVocoder | null = null;
  /** Channel count the current _phaseVocoder was allocated for (PV's channel
   *  count is fixed at construction). Set when allocated, checked on reuse. */
  private _phaseVocoderChannels = 0;
  private _soundTouch: SoundTouch | null = null;
  /** Which engine the current play() is using; null when not stretching. */
  private _activeStretchEngine: 'pv' | 'st' | null = null;

  /** Set the playback speed without (re)initialising the engines. */
  setSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  /**
   * Re-init the appropriate stretch engine for a new play session.
   * Phase vocoder for slowdowns, SoundTouch (WSOLA) for speedups. Each engine
   * is allocated lazily and reset on every reset() so internal buffers start clean.
   */
  reset(): void {
    if (this.playbackSpeed < 1.0) {
      const pvChannels = 2;  // stretch() always produces stereo output
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
   * whatever output frames are currently available. Both engines emit stereo,
   * so mono input is duplicated L=R and >2-channel input is downmixed.
   *
   * `isFinal` is honored only by the phase vocoder (it has tail samples that
   * would otherwise be lost on EOF). SoundTouch buffers minimally per chunk,
   * so the flag is a no-op there.
   */
  stretch(
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
}
