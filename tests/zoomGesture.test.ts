import { describe, it, expect } from 'vitest';
import { wheelZoomFactor, isGestureContinuation } from '../utils/zoomGesture';
import { ZOOM_STEP, WHEEL_NOTCH_DELTA, PINCH_DELTA_PER_STEP, ZOOM_GESTURE_GAP_MS } from '../constants';

describe('isGestureContinuation', () => {
  it('treats events within the gap as one gesture', () => {
    expect(isGestureContinuation(1000, 1000 - (ZOOM_GESTURE_GAP_MS - 1))).toBe(true);
  });
  it('treats a discrete notch as standalone', () => {
    expect(isGestureContinuation(1000, 1000 - (ZOOM_GESTURE_GAP_MS + 1))).toBe(false);
    // Nothing has happened yet: the very first event of a session.
    expect(isGestureContinuation(1000, 0)).toBe(false);
  });
});

describe('wheelZoomFactor', () => {
  it('gives a standalone notch exactly one step, whatever the webview reports', () => {
    // Chromium (~100) and WebKit (~10) notch magnitudes both saturate the cap.
    expect(wheelZoomFactor(100, false)).toBeCloseTo(ZOOM_STEP, 10);
    expect(wheelZoomFactor(WHEEL_NOTCH_DELTA, false)).toBeCloseTo(ZOOM_STEP, 10);
    expect(wheelZoomFactor(-100, false)).toBeCloseTo(ZOOM_STEP, 10);
  });

  it('prices a mid-pinch event well under a notch', () => {
    // The magnitude a WebKit mouse notch reports, arriving mid-gesture, must
    // not be charged as a notch — that is the runaway the pinch scale fixes.
    expect(wheelZoomFactor(WHEEL_NOTCH_DELTA, true)).toBeLessThan(1.05);
  });

  it('is never below 1 and never more than one step', () => {
    for (const d of [0, 0.5, 3, 10, 60, 500, -500]) {
      for (const g of [true, false]) {
        expect(wheelZoomFactor(d, g)).toBeGreaterThanOrEqual(1);
        expect(wheelZoomFactor(d, g)).toBeLessThanOrEqual(ZOOM_STEP + 1e-12);
      }
    }
  });

  it('makes a gesture depend on total finger travel, not the event rate', () => {
    const total = 300;
    const coarse = wheelZoomFactor(total / 10, true) ** 10;
    const fine = wheelZoomFactor(total / 60, true) ** 60;
    expect(coarse).toBeCloseTo(fine, 10);
    expect(fine).toBeCloseTo(ZOOM_STEP ** (total / PINCH_DELTA_PER_STEP), 10);
  });

  it('keeps a whole pinch gesture within a sane zoom range', () => {
    // 60 events/s for a second at a typical per-event delta.
    const gesture = wheelZoomFactor(5, true) ** 60;
    expect(gesture).toBeGreaterThan(2);
    expect(gesture).toBeLessThan(20);
  });
});
