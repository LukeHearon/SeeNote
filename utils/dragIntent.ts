import { DRAG_INTENT_HOLD_MS, DRAG_INTENT_MOVE_FRACTION } from '../constants';

/**
 * Shared drag-intent predicate for the spectrogram and the buzzdetect panel.
 *
 * A mousedown in either place doesn't commit to a drag outright — it records a
 * "pending" intent, so a very short click leaves only its click effect (a seek)
 * behind. The pending intent is promoted to a real drag once the pointer has
 * travelled at least DRAG_INTENT_MOVE_FRACTION of the container's width, OR has
 * been held for at least DRAG_INTENT_HOLD_MS (which lets a deliberate, slow drag
 * start from a near-stationary press).
 *
 * The threshold is a fraction of the container width rather than a fixed pixel
 * count so it feels the same on a narrow and a wide window.
 */
export function shouldPromoteDragIntent(args: {
  /** Width (px) of the element the drag happens in (0 makes any move promote). */
  containerWidth: number;
  /** clientX at mousedown. */
  startX: number;
  /** clientX of the move being evaluated. */
  currentX: number;
  /** Date.now() at mousedown. */
  startTime: number;
  /** Now, in the same clock as startTime. */
  now: number;
}): boolean {
  const { containerWidth, startX, currentX, startTime, now } = args;
  const thresholdPx = containerWidth * DRAG_INTENT_MOVE_FRACTION;
  const dx = Math.abs(currentX - startX);
  return dx >= thresholdPx || now - startTime >= DRAG_INTENT_HOLD_MS;
}
