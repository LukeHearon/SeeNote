import { describe, it, expect } from 'vitest';
import { BuzzdetectData } from '../types';
import {
  detectionRanges,
  subsetTimelineFor,
  subsetBuzzdetectData,
  SubsetCriteria,
} from '../utils/buzzdetectSubset';

// Ten 1s frames at 0,1,...,9. `bee` fires at 1,2,3 and 7; `fly` fires at 5.
const data: BuzzdetectData = {
  binWidth: 1,
  neurons: ['bee', 'fly'],
  starts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  values: [
    [-1, 2, 2, 2, -1, -1, -1, 2, -1, -1],
    [-1, -1, -1, -1, -1, 2, -1, -1, -1, -1],
  ],
};

const criteria = (over: Partial<SubsetCriteria>): SubsetCriteria => ({
  neurons: ['bee'],
  mode: 'activation',
  thresholdOf: () => 0,
  minDetectionRate: 0.5,
  binWidth: 1,
  ...over,
});

describe('detectionRanges — activation mode', () => {
  it('keeps one range per firing frame', () => {
    expect(detectionRanges(data, criteria({}))).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 7, end: 8 },
    ]);
  });

  it('ORs the picked neurons together', () => {
    const r = detectionRanges(data, criteria({ neurons: ['bee', 'fly'] }));
    expect(r.map(x => x.start)).toEqual([1, 2, 3, 5, 7]);
  });

  it('respects the per-neuron threshold', () => {
    expect(detectionRanges(data, criteria({ thresholdOf: () => 5 }))).toEqual([]);
  });

  it('returns nothing when no neuron is picked', () => {
    expect(detectionRanges(data, criteria({ neurons: [] }))).toEqual([]);
  });

  it('ignores neuron labels the file does not have', () => {
    expect(detectionRanges(data, criteria({ neurons: ['wasp'] }))).toEqual([]);
  });
});

describe('detectionRanges — detection-rate mode', () => {
  it('keeps whole bins that reach the minimum rate', () => {
    // 5s bins: [0,5) has 3 of 5 firing (0.6), [5,10) has 1 of 5 (0.2).
    const r = detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 5, minDetectionRate: 0.5 }));
    expect(r).toEqual([{ start: 0, end: 5 }]);
  });

  it('drops bins below the minimum rate', () => {
    expect(detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 5, minDetectionRate: 0.7 })))
      .toEqual([]);
  });

  it('keeps every populated bin at a minimum of 0', () => {
    const r = detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 5, minDetectionRate: 0 }));
    expect(r).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10 }]);
  });

  it('degenerates to the activation test at the native frame length', () => {
    const rate = detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 1, minDetectionRate: 1 }));
    expect(rate).toEqual(detectionRanges(data, criteria({ mode: 'activation' })));
  });

  it('measures a kept bin over its frames, not the bin edge', () => {
    // Frames stop at 9; a 20s bin reaches to 20, but only 0–10 carries frames.
    const r = detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 20, minDetectionRate: 0 }));
    expect(r).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('subsetTimelineFor', () => {
  it('merges contiguous firing frames into one span', () => {
    const tl = subsetTimelineFor(data, criteria({}), 10);
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([[1, 4], [7, 8]]);
    expect(tl.duration).toBe(4);
  });

  it('falls back to the identity timeline with no data or no neurons', () => {
    expect(subsetTimelineFor(null, criteria({}), 10).identity).toBe(true);
    expect(subsetTimelineFor(data, criteria({ neurons: [] }), 10).identity).toBe(true);
    expect(subsetTimelineFor(data, null, 10).identity).toBe(true);
  });
});

describe('subsetBuzzdetectData', () => {
  it('keeps only kept frames and re-anchors them to display time', () => {
    const tl = subsetTimelineFor(data, criteria({}), 10);
    const sub = subsetBuzzdetectData(data, tl)!;
    // Source frames 1,2,3,7 land at display 0,1,2,3.
    expect(sub.starts).toEqual([0, 1, 2, 3]);
    expect(sub.values[0]).toEqual([2, 2, 2, 2]);
    expect(sub.values[1]).toEqual([-1, -1, -1, -1]);
    expect(sub.neurons).toEqual(['bee', 'fly']);
    expect(sub.binWidth).toBe(1);
  });

  it('returns the same object on the identity timeline', () => {
    const tl = subsetTimelineFor(data, criteria({ neurons: [] }), 10);
    expect(subsetBuzzdetectData(data, tl)).toBe(data);
  });

  it('handles null data', () => {
    expect(subsetBuzzdetectData(null, subsetTimelineFor(data, criteria({}), 10))).toBeNull();
  });
});
