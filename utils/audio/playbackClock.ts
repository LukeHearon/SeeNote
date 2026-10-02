/**
 * The linear media↔ctx relation AudioEngine's playhead is built on:
 *   mediaTime = playStartMedia + elapsedCtx * rate
 *
 * `rate` is the stretch engine's *effective* speed (media seconds per output
 * second actually delivered — see TimeStretchEngine.effectiveSpeed), not the
 * requested one: the phase vocoder's integer hop makes them differ slightly,
 * and using the requested speed drifts the playhead off the audio.
 */
export function mediaTimeAt(
  playStartMedia: number,
  elapsedCtxSec: number,
  rate: number,
  duration: number,
  endSec: number | null,
): number {
  if (elapsedCtxSec < 0) return playStartMedia;
  const t = Math.min(playStartMedia + elapsedCtxSec * rate, duration);
  // Clamp to endSec so the playhead never visually overshoots the selection end
  // during the window between source.stop() and the engine's teardown.
  if (endSec !== null && t >= endSec) return endSec;
  return t;
}

/** ctx time at which media position `mediaSec` is reached, for a chunk whose first
 *  sample (media `chunkMediaStart`) is scheduled at `ctxStart`. Inverse of mediaTimeAt. */
export function ctxTimeAtMedia(ctxStart: number, chunkMediaStart: number, mediaSec: number, rate: number): number {
  return ctxStart + (mediaSec - chunkMediaStart) / rate;
}
