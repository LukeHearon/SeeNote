/**
 * Interleaved-PCM helpers shared by the playback engine and the replay cache.
 *
 * Rust hands PCM across IPC as one interleaved f32 buffer (L,R,L,R… in the
 * file's native channel order). Web Audio wants one planar Float32Array per
 * channel, so every consumer of `readPcmChunk` has to split the same way —
 * AudioEngine into fresh per-chunk arrays, PcmCache into a running offset in
 * one long per-channel array. Both go through `deinterleaveInto` so the layout
 * assumption lives in exactly one place.
 */

/**
 * Split `interleaved` into `dest`, one array per channel, writing frame i of
 * channel c at `dest[c][destOffset + i]`.
 *
 * Reads `frames * dest.length` samples starting at `interleaved[0]`; the caller
 * is responsible for `dest[c]` having room for `destOffset + frames`.
 */
export function deinterleaveInto(
  interleaved: Float32Array,
  frames: number,
  dest: Float32Array[],
  destOffset = 0,
): void {
  const channels = dest.length;
  if (channels === 1) {
    // Mono is already planar — one bulk copy instead of a per-sample loop.
    dest[0].set(interleaved.subarray(0, frames), destOffset);
    return;
  }
  for (let c = 0; c < channels; c++) {
    const out = dest[c];
    for (let i = 0; i < frames; i++) {
      out[destOffset + i] = interleaved[i * channels + c];
    }
  }
}

/** `deinterleaveInto` into freshly allocated per-channel arrays of `frames`. */
export function deinterleave(
  interleaved: Float32Array,
  frames: number,
  channels: number,
): Float32Array[] {
  const dest = Array.from({ length: channels }, () => new Float32Array(frames));
  deinterleaveInto(interleaved, frames, dest);
  return dest;
}
