import { describe, it, expect } from 'vitest';
import { shouldPromoteDragIntent } from '../utils/dragIntent';
import { DRAG_INTENT_HOLD_MS, DRAG_INTENT_MOVE_FRACTION } from '../constants';

const base = { containerWidth: 1000, startX: 500, currentX: 500, startTime: 0, now: 0 };

describe('shouldPromoteDragIntent', () => {
  it('does not promote a short, stationary click', () => {
    expect(shouldPromoteDragIntent({ ...base, currentX: 502, now: 40 })).toBe(false);
  });

  it('promotes once the pointer travels the width fraction', () => {
    const thresholdPx = base.containerWidth * DRAG_INTENT_MOVE_FRACTION; // 10px
    expect(shouldPromoteDragIntent({ ...base, currentX: base.startX + thresholdPx - 1 })).toBe(false);
    expect(shouldPromoteDragIntent({ ...base, currentX: base.startX + thresholdPx })).toBe(true);
  });

  it('measures travel in both directions', () => {
    const thresholdPx = base.containerWidth * DRAG_INTENT_MOVE_FRACTION;
    expect(shouldPromoteDragIntent({ ...base, currentX: base.startX - thresholdPx })).toBe(true);
  });

  it('promotes on hold alone, even without movement', () => {
    expect(shouldPromoteDragIntent({ ...base, now: DRAG_INTENT_HOLD_MS - 1 })).toBe(false);
    expect(shouldPromoteDragIntent({ ...base, now: DRAG_INTENT_HOLD_MS })).toBe(true);
  });

  it('scales the distance threshold with the container width', () => {
    // 20px of travel: below 1% of a 4000px container, above 1% of a 200px one.
    expect(shouldPromoteDragIntent({ ...base, containerWidth: 4000, currentX: 520 })).toBe(false);
    expect(shouldPromoteDragIntent({ ...base, containerWidth: 200, currentX: 520 })).toBe(true);
  });

  it('promotes any move when the container has no measured width', () => {
    expect(shouldPromoteDragIntent({ ...base, containerWidth: 0 })).toBe(true);
  });
});
