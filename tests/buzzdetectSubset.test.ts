import { describe, it, expect } from 'vitest';
import { BuzzdetectData } from '../types';
import {
  detectionRanges,
  subsetTimelineFor,
  subsetBuzzdetectData,
  subsetCriteriaFrom,
  SubsetCriteria,
} from '../utils/buzzdetectSubset';
import { DEFAULT_BUZZDETECT_THRESHOLD } from '../constants';

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

  it('keeps a bin at its own nominal edges, not the extent of its frames', () => {
    // Frames stop at 9, but a kept bin is the DECISION unit — its whole
    // nominal span is kept, not just the frames that happened to justify it.
    // (buildSubsetTimeline clamps this to the real file duration downstream;
    // detectionRanges itself doesn't know how long the file is.)
    const r = detectionRanges(data, criteria({ mode: 'detectionRate', binWidth: 20, minDetectionRate: 0 }));
    expect(r).toEqual([{ start: 0, end: 20 }]);
  });
});

describe('detectionRanges — binned activation mode', () => {
  // Same ten frames, but judged as one 5s bin's MEAN activation rather than
  // frame-by-frame: bee averages (-1+2+2+2-1)/5 = 0.8 in [0,5) and
  // (-1-1-1+2-1)/5 = -0.4 in [5,10).
  it('keeps a whole bin when its mean activation clears the threshold', () => {
    const r = detectionRanges(data, criteria({ binWidth: 5, thresholdOf: () => 0 }));
    expect(r).toEqual([{ start: 0, end: 5 }]);
  });

  it('drops a bin whose mean activation falls short', () => {
    const r = detectionRanges(data, criteria({ binWidth: 5, thresholdOf: () => 1 }));
    expect(r).toEqual([]);
  });

  it("ORs neurons against their OWN threshold, not a combined mean", () => {
    // bee's mean never clears 10 in either bin, but fly's mean (-1, then
    // -0.4) always clears its own very low threshold — so both bins are kept
    // on fly alone, proving the OR checks each neuron independently rather
    // than averaging bee and fly together first.
    const thresholdOf = (n: string) => (n === 'bee' ? 10 : -1);
    const r = detectionRanges(data, criteria({ neurons: ['bee', 'fly'], binWidth: 5, thresholdOf }));
    expect(r).toEqual([{ start: 0, end: 5 }, { start: 5, end: 10 }]);
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

// The annotation window and the guide's example panel both build their criteria
// through this, so it pins what "subset off" means in either place.
describe('subsetCriteriaFrom', () => {
  const inputs = {
    enabled: true,
    neurons: ['bee'],
    mode: 'activation' as const,
    thresholds: { bee: 1.5 },
    minDetectionRate: 0.4,
    binWidthOverride: 2,
    frameLength: 0.5,
  };

  it('is null when disabled or nothing is ticked', () => {
    expect(subsetCriteriaFrom({ ...inputs, enabled: false })).toBeNull();
    expect(subsetCriteriaFrom({ ...inputs, neurons: [] })).toBeNull();
  });

  it('carries the picks, mode and rate straight through', () => {
    const c = subsetCriteriaFrom(inputs)!;
    expect(c.neurons).toEqual(['bee']);
    expect(c.mode).toBe('activation');
    expect(c.minDetectionRate).toBeCloseTo(0.4);
  });

  it('falls back to the default threshold for neurons with no override', () => {
    const c = subsetCriteriaFrom(inputs)!;
    expect(c.thresholdOf('bee')).toBe(1.5);
    expect(c.thresholdOf('fly')).toBe(DEFAULT_BUZZDETECT_THRESHOLD);
  });

  it('uses the pinned bin width, falling back to the frame length', () => {
    expect(subsetCriteriaFrom(inputs)!.binWidth).toBe(2);
    expect(subsetCriteriaFrom({ ...inputs, binWidthOverride: null })!.binWidth).toBe(0.5);
  });
});
