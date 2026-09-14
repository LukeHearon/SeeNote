import { ZOOM_STEP, WHEEL_NOTCH_DELTA, PINCH_DELTA_PER_STEP, ZOOM_GESTURE_GAP_MS } from '../constants';

// Wheel-driven zoom stepping.
//
// The same ctrl+wheel event stream carries two very different devices:
//
//   - A mouse notch is a discrete, isolated event. Its |deltaY| is whatever the
//     webview reports for one notch (Chromium ~100, WebKit ~10), and the user
//     expects one notch to be one ZOOM_STEP regardless.
//   - A trackpad pinch is a continuous burst — 4-5 events per frame for as long
//     as the fingers move — where |deltaY| is proportional to how far they
//     moved. Sizing each of those events as a notch multiplies the zoom by
//     thousands over one gesture.
//
// Magnitude alone cannot separate them (a WebKit notch and a mid-pinch event
// are both ~10), so the discriminator is continuity: an event that follows the
// previous one within ZOOM_GESTURE_GAP_MS is part of a gesture. Gesture events
// are priced off the pinch scale, which makes the total zoom a function of the
// total finger travel (exp of the summed delta) rather than of the event rate —
// so the same pinch zooms the same amount on a 60Hz and a 120Hz trackpad.
//
// The first event of a pinch is necessarily judged as a notch (nothing precedes
// it), so a gesture opens with at most one ZOOM_STEP before the pinch scale
// takes over.

export const isGestureContinuation = (nowMs: number, lastEventMs: number): boolean =>
  nowMs - lastEventMs < ZOOM_GESTURE_GAP_MS;

/**
 * Multiplicative zoom step for one wheel event. Always >= 1; the caller applies
 * it as a multiply (zoom out) or a divide (zoom in) per the delta's sign.
 */
export const wheelZoomFactor = (deltaY: number, inGesture: boolean): number => {
  const perStep = inGesture ? PINCH_DELTA_PER_STEP : WHEEL_NOTCH_DELTA;
  // Capped so one event can never exceed a single step: a notch at or above the
  // notch delta is exactly ZOOM_STEP, and a coarse/accelerated pinch event
  // can't jump the view a whole gesture's worth in one frame.
  const magnitude = Math.min(Math.abs(deltaY), perStep);
  return Math.exp((magnitude / perStep) * Math.log(ZOOM_STEP));
};
