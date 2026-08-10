import { describe, it, expect } from 'vitest';
import { BuzzdetectData } from '../types';
import { subsetStats } from '../utils/buzzdetectStats';
import { buildSubsetTimeline, identityTimeline } from '../utils/subsetTimeline';

// Ten 1s frames at 0…9 in a 10s file.
const data: BuzzdetectData = {
  frameLength: 1,
  frameHop: 1,
  neurons: ['bee'],
  starts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  values: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
};

describe('subsetStats', () => {
  it('is null for the identity timeline', () => {
    expect(subsetStats(data, identityTimeline(10), 10)).toBeNull();
  });

  it('counts kept seconds, regions and frames', () => {
    // Source [1,4) and [7,8): 4s over two stretches, holding frames 1,2,3,7.
    const tl = buildSubsetTimeline([{ start: 1, end: 4 }, { start: 7, end: 8 }], 10);
    expect(subsetStats(data, tl, 10)).toEqual({
      keptSeconds: 4,
      sourceSeconds: 10,
      regions: 2,
      frames: 4,
      fraction: 0.4,
    });
  });

  // Regions are merged spans, not kept bins — three abutting 1s bins are one
  // stretch of audio to navigate, and that's what the readout should say.
  it('counts contiguous bins as one region', () => {
    const tl = buildSubsetTimeline([{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }], 10);
    expect(subsetStats(data, tl, 10)!.regions).toBe(1);
  });

  it('counts every frame inside a span, not one per region', () => {
    const dense: BuzzdetectData = { ...data, frameHop: 0.25, frameLength: 0.25, starts: [1, 1.25, 1.5, 1.75, 5] };
    const tl = buildSubsetTimeline([{ start: 1, end: 2 }], 10);
    expect(subsetStats(dense, tl, 10)!.frames).toBe(4);
  });

  it('survives a null data / zero-length file', () => {
    const tl = buildSubsetTimeline([{ start: 1, end: 2 }], 10);
    expect(subsetStats(null, tl, 10)!.frames).toBe(0);
    expect(subsetStats(data, buildSubsetTimeline([], 0), 0)!.fraction).toBe(0);
  });

  // A subset that keeps nothing is not the identity case — it's a threshold
  // set too high, and saying "0s kept" is the whole point of the readout.
  it('reports an empty subset rather than null', () => {
    expect(subsetStats(data, buildSubsetTimeline([], 10), 10)).toEqual({
      keptSeconds: 0,
      sourceSeconds: 10,
      regions: 0,
      frames: 0,
      fraction: 0,
    });
  });
});
