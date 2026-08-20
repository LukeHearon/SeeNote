import { describe, it, expect } from 'vitest';
import { BuzzdetectData } from '../types';
import {
  detectionRanges,
  subsetTimelineFor,
  subsetBuzzdetectData,
  subsetCriteriaFrom,
  SubsetCriteria,
} from '../utils/buzzdetectSubset';
import { bucketFrameRange } from '../utils/binIndex';

// Ten 1s frames at 0,1,...,9. `bee` fires at 1,2,3 and 7; `fly` fires at 5.
const data: BuzzdetectData = {
  frameLength: 1,
  frameHop: 1,
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
  buffer: 0,
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

describe('detectionRanges — bin partition', () => {
  // detectionRanges walks the frames forward rather than binary-searching each
  // bin, so it has to land on the SAME partition the panel draws
  // (binIndex.bucketFrameRange). The two disagree if the walk derives a frame's
  // bin by dividing: at the native frame length every frame start sits exactly
  // on a bin edge, and 0.96*i/0.96 is a float ulp under i often enough to shunt
  // scattered frames into their neighbour's bin — which silently changes which
  // stretches of audio the subset keeps.
  const frame = 0.96;
  const n = 500;
  const noisy: BuzzdetectData = {
    frameLength: frame,
    frameHop: frame,
    neurons: ['bee'],
    starts: Array.from({ length: n }, (_, i) => i * frame),
    values: [Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 2 : -1))],
  };

  // The partition stated directly: bin by bin, through the same lookup the
  // panel uses. Slow (a binary search per bin) — which is why detectionRanges
  // doesn't do it — but unambiguous about which frames belong to which bin.
  const byBucket = (d: BuzzdetectData, bin: number, threshold: number) => {
    const out: { start: number; end: number }[] = [];
    const lastBin = Math.floor(d.starts[d.starts.length - 1] / bin);
    for (let b = Math.floor(d.starts[0] / bin); b <= lastBin; b++) {
      const r = bucketFrameRange(d.starts, bin, b);
      if (!r) continue;
      let sum = 0;
      for (let i = r.start; i <= r.end; i++) sum += d.values[0][i];
      if (sum / (r.end - r.start + 1) >= threshold) out.push({ start: b * bin, end: (b + 1) * bin });
    }
    return out;
  };

  it('agrees with the panel\'s bucket partition on float-noisy frame starts', () => {
    for (const bin of [frame, 2 * frame, 5, 60]) {
      expect(detectionRanges(noisy, criteria({ binWidth: bin })))
        .toEqual(byBucket(noisy, Math.max(bin, frame), 0));
    }
  });

  it('keeps every frame that fires, one bin each, at the native frame length', () => {
    // 500 frames, every 7th firing → 72 kept bins, none merged or dropped.
    expect(detectionRanges(noisy, criteria({ binWidth: frame }))).toHaveLength(72);
  });
});

// Overlapping frames: buzzdetect's `framelength 3, framehop 0.96` produces
// rows 0.96s apart that each speak for 3s of audio. Setting the frame length
// used to be routed into the bin width, which grouped ~3 frames per bin and
// judged their MEAN — so a longer frame made the subset SMALLER, the opposite
// of what the setting reads as. The length now moves only the frames' extent.
describe('detectionRanges — frames longer than the hop', () => {
  const hop = 1;
  // Frames every 1s; only frame 3 fires.
  const overlapped = (frameLength: number): BuzzdetectData => ({
    frameLength,
    frameHop: hop,
    neurons: ['bee'],
    starts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    values: [[-1, -1, -1, 2, -1, -1, -1, -1, -1, -1]],
  });

  it('judges per frame regardless of the frame length', () => {
    // One kept bin either way — the neighbours never get averaged in.
    for (const len of [hop, 3, 5]) {
      expect(detectionRanges(overlapped(len), criteria({ binWidth: hop }))).toHaveLength(1);
    }
  });

  it('extends a kept bin by the overhang, so a longer frame keeps more audio', () => {
    expect(detectionRanges(overlapped(hop), criteria({ binWidth: hop })))
      .toEqual([{ start: 3, end: 4 }]);
    // The firing frame at 3 covers [3,6): its bin's far edge moves out by the
    // 2s the frame reaches past the next frame's start.
    expect(detectionRanges(overlapped(3), criteria({ binWidth: hop })))
      .toEqual([{ start: 3, end: 6 }]);
  });

  it('grows the kept audio monotonically with the frame length', () => {
    const kept = (len: number) => subsetTimelineFor(overlapped(len), criteria({ binWidth: hop }), 10).duration;
    expect(kept(1)).toBe(1);
    expect(kept(3)).toBe(3);
    expect(kept(5)).toBe(5);
  });

  it('merges the overlapping ranges neighbouring detections produce', () => {
    // Frames 3 and 5 fire; at length 3 they cover [3,6) and [5,8), which
    // overlap and must come out as one span rather than two.
    const d = overlapped(3);
    d.values[0][5] = 2;
    const tl = subsetTimelineFor(d, criteria({ binWidth: hop }), 10);
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([[3, 8]]);
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
    expect(sub.frameLength).toBe(1);
    expect(sub.frameHop).toBe(1);
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
    subsetThresholds: { bee: 1.5 },
    thresholds: { bee: 0.25, fly: 0.75 },
    mode: 'activation' as const,
    minDetectionRate: 0.4,
    binWidthOverride: 2,
    frameHop: 0.5,
    buffer: 0,
    availableNeurons: ['bee', 'fly'],
  };

  it('is null when disabled or nothing is picked', () => {
    expect(subsetCriteriaFrom({ ...inputs, enabled: false })).toBeNull();
    expect(subsetCriteriaFrom({ ...inputs, subsetThresholds: {} })).toBeNull();
  });

  // Picks are saved per project and keyed by neuron label, so a track scored by
  // a different model carries picks naming columns it hasn't got. Cutting by
  // those would match nothing and blank the track.
  it('ignores picks this file has no column for', () => {
    const c = subsetCriteriaFrom({
      ...inputs,
      subsetThresholds: { bee: 1.5, wasp: 1.5 },
    })!;
    expect(c.neurons).toEqual(['bee']);
  });

  it('is null when no pick survives, rather than cutting to nothing', () => {
    expect(subsetCriteriaFrom({ ...inputs, subsetThresholds: { wasp: 1.5 } })).toBeNull();
    // No results loaded at all — same story.
    expect(subsetCriteriaFrom({ ...inputs, availableNeurons: null })).toBeNull();
  });

  // The picks ARE the threshold map's keys — there's no second list that could
  // name a neuron the thresholds don't, or vice versa.
  it('takes the picks from the subset thresholds', () => {
    const c = subsetCriteriaFrom({ ...inputs, subsetThresholds: { bee: 1.5, fly: -1 } })!;
    expect(c.neurons).toEqual(['bee', 'fly']);
    expect(c.mode).toBe('activation');
    expect(c.minDetectionRate).toBeCloseTo(0.4);
  });

  // The point of the separate subset threshold: cut liberally, mark strictly.
  it('cuts at the subset threshold in activation mode', () => {
    const c = subsetCriteriaFrom({ ...inputs, subsetThresholds: { bee: -1.5 } })!;
    expect(c.thresholdOf('bee')).toBe(-1.5);
  });

  // A detection RATE already counts frames that ARE detections, so the only
  // threshold that means anything there is the one defining a detection; the
  // pick's stored value is just a marker.
  it('cuts at the detection threshold in detection-rate mode', () => {
    const c = subsetCriteriaFrom({ ...inputs, mode: 'detectionRate', subsetThresholds: { bee: -1.5 } })!;
    expect(c.thresholdOf('bee')).toBe(0.25);
    expect(c.thresholdOf('wasp')).toBe(Infinity);
  });

  // A cleared threshold is a neuron that never detects, so a detection-rate cut
  // keyed to it keeps nothing rather than falling back to the default.
  it('treats a null detection threshold as unreachable', () => {
    const c = subsetCriteriaFrom({
      ...inputs,
      mode: 'detectionRate',
      subsetThresholds: { bee: -1.5 },
      thresholds: { bee: null },
    })!;
    expect(c.thresholdOf('bee')).toBe(Infinity);
    expect(detectionRanges(data, { ...c, neurons: ['bee'], binWidth: 1, minDetectionRate: 0.5 })).toEqual([]);
  });

  // The hop, never the frame length: how much audio a frame covers is not a
  // statement about how frames should be grouped for judging, and routing the
  // frame length in here is what made a longer frame SHRINK the subset.
  it('uses the pinned bin width, falling back to the frame hop', () => {
    expect(subsetCriteriaFrom(inputs)!.binWidth).toBe(2);
    expect(subsetCriteriaFrom({ ...inputs, binWidthOverride: null })!.binWidth).toBe(0.5);
  });

  it('never lets a negative buffer shrink the cut', () => {
    expect(subsetCriteriaFrom({ ...inputs, buffer: 3 })!.buffer).toBe(3);
    expect(subsetCriteriaFrom({ ...inputs, buffer: -3 })!.buffer).toBe(0);
  });

  // Padding a kept region reads as "the moments either side of this frame", and
  // that only holds where the kept thing IS a frame. A detection rate is a
  // summary over a bin the user sized themselves.
  it('drops the buffer outside activation mode', () => {
    expect(subsetCriteriaFrom({ ...inputs, mode: 'detectionRate', buffer: 3 })!.buffer).toBe(0);
  });
});

// A buffer widens every kept region by the same amount on each side, without
// changing which bins were kept.
describe('detectionRanges — buffer', () => {
  it('pads each kept bin on both sides', () => {
    const r = detectionRanges(data, criteria({ neurons: ['fly'], buffer: 3 }));
    // `fly` fires only in the 1s bin starting at 5.
    expect(r).toEqual([{ start: 2, end: 9 }]);
  });

  it('leaves the padding to be clamped and merged by the timeline', () => {
    // Adjacent detections at 1,2,3 pad into overlapping ranges; the timeline
    // merges them, and clamps the first one's negative start to the file.
    const tl = subsetTimelineFor(data, criteria({ buffer: 3 }), 10);
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([[0, 10]]);
  });

  it('keeps separate detections separate when the buffer does not reach', () => {
    const tl = subsetTimelineFor(data, criteria({ neurons: ['bee', 'fly'], buffer: 0.25 }), 20);
    expect(tl.spans.map(s => [s.srcStart, s.srcEnd])).toEqual([
      [0.75, 4.25],
      [4.75, 6.25],
      [6.75, 8.25],
    ]);
  });
});
