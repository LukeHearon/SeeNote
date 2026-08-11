import { describe, it, expect } from 'vitest';
import { rampVelocityPx, scrubStep, scrubTarget } from '../utils/arrowScrub';

describe('scrubTarget', () => {
  it('moves by 10% of the visible window', () => {
    expect(scrubStep(20)).toBe(2);
    expect(scrubTarget(10, 100, 20, 1)).toBe(12);
    expect(scrubTarget(10, 100, 20, -1)).toBe(8);
  });

  it('clamps to the track', () => {
    expect(scrubTarget(1, 100, 20, -1)).toBe(0);
    expect(scrubTarget(99, 100, 20, 1)).toBe(100);
  });
});

describe('rampVelocityPx', () => {
  it('stays still through the tap grace period, so a tap is one pixel', () => {
    expect(rampVelocityPx(0)).toBe(0);
    expect(rampVelocityPx(0.24)).toBe(0);
  });

  it('opens at one pixel per frame and accelerates from there', () => {
    expect(rampVelocityPx(0.25)).toBe(60);
    expect(rampVelocityPx(0.75)).toBeGreaterThan(60);
    expect(rampVelocityPx(1.25)).toBeGreaterThan(rampVelocityPx(0.75));
  });

  it('caps out rather than running away', () => {
    expect(rampVelocityPx(10)).toBe(1500);
    expect(rampVelocityPx(1000)).toBe(1500);
  });
});
