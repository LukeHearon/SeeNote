import { describe, it, expect } from 'vitest';
import { gainToSlider, sliderToGain } from '../components/VolumeControl';

describe('volume slider mapping', () => {
  it('puts unity gain at the slider centre', () => {
    expect(sliderToGain(0.5)).toBeCloseTo(1);
    expect(gainToSlider(1)).toBeCloseTo(0.5);
  });

  it('covers 0→1 over the lower half', () => {
    expect(sliderToGain(0)).toBeCloseTo(0);
    expect(sliderToGain(0.25)).toBeCloseTo(0.5);
  });

  it('boosts to 8× at the top of the slider', () => {
    expect(sliderToGain(1)).toBeCloseTo(8);
    expect(gainToSlider(8)).toBeCloseTo(1);
  });

  it('round-trips across the range', () => {
    for (const s of [0, 0.1, 0.5, 0.75, 1]) {
      expect(gainToSlider(sliderToGain(s))).toBeCloseTo(s);
    }
  });
});
