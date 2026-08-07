import { describe, it, expect } from 'vitest';
import {
  MultiTierSpectrogramCache,
  chunkIndicesForRanges,
  swapChunkCache,
  takeContiguousRun,
} from '../MultiTierSpectrogramCache';
import {
  buildTierLadder,
  COLS_PER_CHUNK,
  FINEST_HOP_SAMPLES,
  MIN_COLS_PER_CHUNK,
  OVERVIEW_TARGET_COLS,
  SUBSET_TIER_CACHE_BYTES,
  TIER_HOP_RATIO,
} from '../constants';

// ── Test scaffolding ─────────────────────────────────────────────────────────
//
// We only exercise pure logic: `buildTierLadder` and `selectTier`. The latter
// depends on the ladder built in the constructor plus `activeTierIndex`
// (hysteresis state). Nothing here touches a code path that needs a fetched
// chunk, so no Tauri IPC stubbing is required beyond tests/setup.ts.
//
// The ladder is per-file now, so the tier numbers below follow from
// SAMPLE_RATE/DURATION rather than from a fixed table. For a 1h file at 48 kHz
// the ladder steps by 4 from a 512-sample hop until one tier covers the file in
// under OVERVIEW_TARGET_COLS columns:
//
//   tier 0: hop 524288 → colsPerSec  0.092   (coarsest; whole file ≈ 330 cols)
//   tier 1: hop 131072 → colsPerSec  0.366
//   tier 2: hop  32768 → colsPerSec  1.465
//   tier 3: hop   8192 → colsPerSec  5.859
//   tier 4: hop   2048 → colsPerSec 23.438
//   tier 5: hop    512 → colsPerSec 93.75    (finest)
//
// `selectTier` picks the FIRST tier (coarsest, lowest index) whose colsPerSec
// is >= pixelsPerSec = canvasWidth / visibleDuration. If none qualifies, it
// falls back to the finest tier (last index).

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;
const DURATION = 3600; // 1 hour

function makeCache(): MultiTierSpectrogramCache {
  return new MultiTierSpectrogramCache(
    '/nonexistent/test.wav',
    FFT_SIZE,
    SAMPLE_RATE,
    DURATION,
    () => {},
  );
}

const LADDER = buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE);

describe('buildTierLadder', () => {
  it('orders tiers coarsest-to-finest with tier number = index', () => {
    expect(LADDER.map(t => t.tier)).toEqual(LADDER.map((_, i) => i));
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i].colsPerSec).toBeGreaterThan(LADDER[i - 1].colsPerSec);
      expect(LADDER[i].hopSize).toBe(LADDER[i - 1].hopSize / TIER_HOP_RATIO);
    }
  });

  it('always ends at the finest hop', () => {
    for (const dur of [4, 300, 3600, 50 * 3600]) {
      const ladder = buildTierLadder(SAMPLE_RATE, dur, FFT_SIZE);
      expect(ladder[ladder.length - 1].hopSize).toBe(FINEST_HOP_SAMPLES);
    }
  });

  it('extends only as far as the file needs — a short clip gets one tier', () => {
    // 4s at 48 kHz is 375 columns at the finest hop, already under the
    // whole-file budget, so no coarse tier is worth building.
    const ladder = buildTierLadder(SAMPLE_RATE, 4, FFT_SIZE);
    expect(ladder).toHaveLength(1);
    expect(ladder[0].hopSize).toBe(FINEST_HOP_SAMPLES);
  });

  it('reaches a tier that covers the whole file within the column budget', () => {
    // The regression this ladder exists for: the old fixed table bottomed out
    // at 1 col/s, so a 50h file viewed whole needed 180,000 columns.
    for (const dur of [300, 3600, 50 * 3600]) {
      const ladder = buildTierLadder(SAMPLE_RATE, dur, FFT_SIZE);
      const coarsest = ladder[0];
      expect(dur * coarsest.colsPerSec).toBeLessThanOrEqual(OVERVIEW_TARGET_COLS);
      // ...and no coarser than it needs to be: one tier finer would exceed it
      // (except for a single-tier ladder, which is already at the finest hop).
      if (ladder.length > 1) {
        expect(dur * ladder[1].colsPerSec).toBeGreaterThan(OVERVIEW_TARGET_COLS);
      }
    }
  });

  it('keeps a whole-file view at a few columns per pixel, at any file length', () => {
    // The property the ladder exists to guarantee: the cost of viewing an
    // entire file scales with the window, not with the file. Under the old
    // fixed table a 50h file wanted 180,000 columns for a 1600px window — 112
    // per pixel. Checked through selectTier, which is what the renderer calls.
    const canvasWidth = 1600;
    for (const dur of [4, 300, 3600, 50 * 3600]) {
      const cache = new MultiTierSpectrogramCache(
        '/nonexistent/test.wav', FFT_SIZE, SAMPLE_RATE, dur, () => {},
      );
      const selected = cache.selectTier(dur, canvasWidth);
      const colsPerPixel = (dur * selected.colsPerSec) / canvasWidth;
      // selectTier takes the coarsest tier that still covers the pixel rate,
      // so it overshoots by at most one ladder step.
      expect(colsPerPixel).toBeLessThanOrEqual(TIER_HOP_RATIO);
    }
  });

  it('sizes chunks at a fixed column count, not a fixed duration', () => {
    for (const t of LADDER) {
      expect(t.chunkDuration * t.colsPerSec).toBeCloseTo(COLS_PER_CHUNK, 6);
    }
  });

  it('shrinks the per-tier chunk budget as fftSize (and so chunk size) grows', () => {
    const small = buildTierLadder(SAMPLE_RATE, DURATION, 512)[0].maxChunks;
    const large = buildTierLadder(SAMPLE_RATE, DURATION, 4096)[0].maxChunks;
    expect(large).toBeLessThan(small);
    expect(large).toBeGreaterThanOrEqual(4); // never below the floor
  });

  it('sizes a subset-grained chunk at the grain, at the tiers that can', () => {
    // 2s bins on the 1h/48kHz ladder. The finest tiers can spend a chunk on 2s
    // and still clear the column floor; the coarse ones can't (2s of tier 0 is
    // a fifth of a column) and bottom out there instead.
    const grain = 2;
    const ladder = buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE, grain);
    for (const t of ladder) {
      const cols = t.chunkDuration * t.colsPerSec;
      expect(cols).toBeGreaterThanOrEqual(MIN_COLS_PER_CHUNK);
      expect(cols).toBeLessThanOrEqual(COLS_PER_CHUNK);
      // Either it hit a clamp, or the chunk is the grain (rounded up to a
      // whole column).
      if (cols > MIN_COLS_PER_CHUNK && cols < COLS_PER_CHUNK) {
        expect(t.chunkDuration).toBeGreaterThanOrEqual(grain);
        expect(t.chunkDuration - grain).toBeLessThan(1 / t.colsPerSec);
      }
    }
    // The finest tier is the one the subset is actually read at.
    expect(ladder[ladder.length - 1].chunkDuration).toBeCloseTo(grain, 1);
  });

  it('cuts the bytes a short detection costs, which is the point of the grain', () => {
    // A 2s detection at the finest tier. Ungrained, it sits inside one ~11.9s
    // (48kHz: 10.9s) chunk and drags all of it through decode, IPC and cache.
    const grain = 2;
    const span = { start: 1234.5, end: 1236.5 };
    const bytesFor = (t: { chunkDuration: number; colsPerSec: number }) => {
      const chunks = Math.floor(span.end / t.chunkDuration) - Math.floor(span.start / t.chunkDuration) + 1;
      return chunks * t.chunkDuration * t.colsPerSec * (FFT_SIZE / 2) * 2;
    };
    const finest = (l: ReturnType<typeof buildTierLadder>) => l[l.length - 1];
    const plain = bytesFor(finest(buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE)));
    const grained = bytesFor(finest(buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE, grain)));
    expect(grained).toBeLessThan(plain / 2);
  });

  it('holds far more chunks under a subset — smaller chunks and a bigger budget', () => {
    const plain = buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE);
    const grained = buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE, 2);
    const finest = plain.length - 1;
    expect(grained[finest].maxChunks).toBeGreaterThan(plain[finest].maxChunks);
    // Still inside the byte budget it was derived from.
    const bytes = grained[finest].maxChunks
      * grained[finest].chunkDuration * grained[finest].colsPerSec * (FFT_SIZE / 2) * 2;
    expect(bytes).toBeLessThanOrEqual(SUBSET_TIER_CACHE_BYTES * 1.05);
  });

  it('ignores a grain it cannot honour (no sample rate yet, or no bin width)', () => {
    const plain = buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE);
    for (const ladder of [
      buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE, 0),
      buildTierLadder(SAMPLE_RATE, DURATION, FFT_SIZE, undefined),
    ]) {
      expect(ladder.map(t => t.chunkDuration)).toEqual(plain.map(t => t.chunkDuration));
    }
    // A file we don't know the rate of yet must still yield a usable tier.
    const unknown = buildTierLadder(0, 0, FFT_SIZE, 2);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].maxChunks).toBeGreaterThanOrEqual(4);
  });

  it('survives an unknown file (zero duration) with a usable single tier', () => {
    const ladder = buildTierLadder(SAMPLE_RATE, 0, FFT_SIZE);
    expect(ladder).toHaveLength(1);
    expect(ladder[0].colsPerSec).toBeGreaterThan(0);
  });
});

describe('MultiTierSpectrogramCache.selectTier', () => {
  it('returns a near-coarsest tier when the full file is visible', () => {
    const cache = makeCache();
    // 3600s over 1000px = 0.278 px/s. Tier 0 (0.092 col/s) is deliberately
    // coarser than any screen's pixel rate, so tier 1 (0.366) is the coarsest
    // that still covers it.
    expect(cache.selectTier(DURATION, 1000).tier).toBe(1);
  });

  it('returns the finest tier for extremely high zoom', () => {
    const cache = makeCache();
    // 0.1s over 1000px = 10000 px/s. No tier qualifies, so it falls through
    // to the finest.
    expect(cache.selectTier(0.1, 1000).tier).toBe(LADDER.length - 1);
  });

  it('picks a tier whose column rate just covers the pixel rate', () => {
    const cache = makeCache();
    // Exactly tier 3's colsPerSec (5.859 px/s) → tier 3, not tier 4.
    const visible = 1000 / LADDER[3].colsPerSec;
    expect(cache.selectTier(visible, 1000).tier).toBe(3);
  });

  it('hysteresis: a small zoom change does NOT thrash tiers', () => {
    const cache = makeCache();
    expect(cache.selectTier(1000 / LADDER[3].colsPerSec, 1000).tier).toBe(3);

    // pps just above tier 3's rate: the pure best would step to tier 4, but
    // ratio = 5.859 / 6.5 = 0.90 is inside [0.5, 3.0], so we hold.
    expect(cache.selectTier(1000 / 6.5, 1000).tier).toBe(3);
  });

  it('hysteresis releases on a large zoom-in (ratio < 0.5)', () => {
    const cache = makeCache();
    expect(cache.selectTier(1000 / LADDER[3].colsPerSec, 1000).tier).toBe(3);
    // pps 20 → ratio 5.859/20 = 0.29 → release; coarsest tier clearing 20 is 4.
    expect(cache.selectTier(1000 / 20, 1000).tier).toBe(4);
  });

  it('hysteresis releases on a large zoom-out (ratio > 3.0)', () => {
    const cache = makeCache();
    // Land on the finest tier, then zoom way out.
    expect(cache.selectTier(0.1, 1000).tier).toBe(LADDER.length - 1);
    // pps 1 → ratio 93.75/1 → release; coarsest tier clearing 1 col/s is 2.
    expect(cache.selectTier(1000 / 1, 1000).tier).toBe(2);
  });

  it('exposes a hop and column rate consistent with the sample rate', () => {
    const cache = makeCache();
    const t = cache.selectTier(DURATION, 1000);
    expect(t.colsPerSec).toBeCloseTo(SAMPLE_RATE / t.hopSize, 10);
    expect(t.chunkDuration).toBeCloseTo((COLS_PER_CHUNK * t.hopSize) / SAMPLE_RATE, 10);
  });

  it('first call (no prior activeTierIndex) picks the pure-best tier', () => {
    const cache = makeCache();
    // No hysteresis state yet, so this goes straight to the best fit.
    expect(cache.selectTier(1000 / 20, 1000).tier).toBe(4);
  });
});

describe('swapChunkCache', () => {
  it('invalidates the outgoing cache and installs the new one', () => {
    const outgoing = makeCache();
    const incoming = makeCache();
    // Queue work on the outgoing cache so there is something to tear down.
    outgoing.prefetchViewport(0, 60, 1);
    const ref: { current: MultiTierSpectrogramCache | null } = { current: outgoing };

    swapChunkCache(ref, incoming);

    expect(ref.current).toBe(incoming);
    // invalidate() drops both the queue and the in-flight bookkeeping, so the
    // retired cache stops reporting (and scheduling) work for the old file.
    expect(outgoing.pendingCount()).toBe(0);
  });

  it('drops the current cache when passed null', () => {
    const outgoing = makeCache();
    const ref: { current: MultiTierSpectrogramCache | null } = { current: outgoing };
    swapChunkCache(ref, null);
    expect(ref.current).toBeNull();
  });

  it('is a no-op teardown when the same cache is re-installed', () => {
    const cache = makeCache();
    const ref: { current: MultiTierSpectrogramCache | null } = { current: cache };
    swapChunkCache(ref, cache);
    expect(ref.current).toBe(cache);
  });
});

describe('chunkIndicesForRanges', () => {
  it('pads a single contiguous range by one chunk on each side', () => {
    // Scroll margin: the view sits in chunk 5, so 4..6 are wanted.
    expect(chunkIndicesForRanges([{ start: 55, end: 59 }], 10, 3600, true))
      .toEqual([4, 5, 6]);
  });

  it('does not pad when the viewport is several disjoint spans', () => {
    // Each span is one chunk; padding them would fetch (and cache) three times
    // as much for file time the subset has hidden and will never display.
    expect(chunkIndicesForRanges(
      [{ start: 55, end: 59 }, { start: 205, end: 209 }], 10, 3600, false,
    )).toEqual([5, 20]);
  });

  it('dedupes spans that land in the same chunk', () => {
    expect(chunkIndicesForRanges(
      [{ start: 51, end: 52 }, { start: 55, end: 56 }, { start: 58, end: 59 }],
      10, 3600, false,
    )).toEqual([5]);
  });

  it('never asks for a chunk starting past the end of the file', () => {
    expect(chunkIndicesForRanges([{ start: 95, end: 100 }], 10, 100, true))
      .toEqual([8, 9]);
  });

  it('clamps the padded start at zero', () => {
    expect(chunkIndicesForRanges([{ start: 0, end: 5 }], 10, 3600, true))
      .toEqual([0, 1]);
  });
});

describe('MultiTierSpectrogramCache.prefetchRanges', () => {
  // The subset regression: one screenful can be many disjoint stretches of the
  // file, and each prefetch call REPLACES the queue. Fetching them one range at
  // a time therefore had every span but the last cancel the span before it, so
  // most segments never loaded — they drew blank or from a coarse fallback, and
  // which ones won changed frame to frame (the flicker).
  const spans = (n: number, tierConfig: { chunkDuration: number }) =>
    // Every other chunk, well inside it, so each span is exactly one chunk.
    Array.from({ length: n }, (_, i) => ({
      start: (2 * i + 0.25) * tierConfig.chunkDuration,
      end: (2 * i + 0.5) * tierConfig.chunkDuration,
    }));

  it('queues every span in one pass', () => {
    const cache = makeCache();
    const tier = LADDER[LADDER.length - 1];
    const ranges = spans(12, tier);
    cache.prefetchRanges(ranges, tier.tier);
    // Nothing is cached yet, so all 12 distinct chunks must be pending
    // (queued or in flight) — the fetches themselves reject under the test
    // stub, but only asynchronously.
    expect(cache.pendingCount()).toBe(12);
  });

  it('reports the viewport unresolved until every span has its chunk', () => {
    const cache = makeCache();
    const tier = LADDER[LADDER.length - 1];
    const ranges = spans(5, tier);
    expect(cache.isViewportResolvedForRanges(ranges, tier.tier)).toBe(false);
  });

  it('an empty range list is trivially resolved', () => {
    const cache = makeCache();
    expect(cache.isViewportResolvedForRanges([], 1)).toBe(true);
  });
});

describe('takeContiguousRun', () => {
  const q = (tier: number, ...indices: number[]) =>
    indices.map(chunkIndex => ({ tier, chunkIndex }));

  it('returns null for an empty queue', () => {
    expect(takeContiguousRun([], 4)).toBeNull();
  });

  it('takes just the head when the run is capped at one', () => {
    const queue = q(2, 5, 6, 7);
    expect(takeContiguousRun(queue, 1)).toEqual({ tier: 2, firstIndex: 5, count: 1 });
    // The rest stays queued, in order.
    expect(queue).toEqual(q(2, 6, 7));
  });

  it('grows forward from the head before backward', () => {
    // Centre-out queueing puts the forward neighbour ahead of the backward one,
    // and a range is walked forward, so forward growth is preferred.
    const queue = q(1, 10, 11, 9);
    expect(takeContiguousRun(queue, 2)).toEqual({ tier: 1, firstIndex: 10, count: 2 });
    expect(queue).toEqual(q(1, 9));
  });

  it('spans both directions when the cap allows', () => {
    const queue = q(1, 10, 11, 9, 12, 8);
    expect(takeContiguousRun(queue, 5)).toEqual({ tier: 1, firstIndex: 8, count: 5 });
    expect(queue).toEqual([]);
  });

  it('stops at a gap rather than covering chunks that were not queued', () => {
    // 12 is missing: including it would compute a chunk nobody asked for and,
    // worse, report it as part of a contiguous walk.
    const queue = q(0, 10, 11, 13, 14);
    expect(takeContiguousRun(queue, 4)).toEqual({ tier: 0, firstIndex: 10, count: 2 });
    expect(queue).toEqual(q(0, 13, 14));
  });

  it('never mixes tiers into one run', () => {
    const queue = [
      { tier: 1, chunkIndex: 5 },
      { tier: 2, chunkIndex: 6 },
      { tier: 1, chunkIndex: 6 },
    ];
    expect(takeContiguousRun(queue, 4)).toEqual({ tier: 1, firstIndex: 5, count: 2 });
    expect(queue).toEqual([{ tier: 2, chunkIndex: 6 }]);
  });

  it('drains a queue completely across repeated calls', () => {
    const queue = q(3, 4, 5, 6, 7, 8);
    const runs: Array<{ firstIndex: number; count: number }> = [];
    let guard = 0;
    while (queue.length > 0 && guard++ < 10) {
      const run = takeContiguousRun(queue, 2)!;
      runs.push({ firstIndex: run.firstIndex, count: run.count });
    }
    expect(queue).toEqual([]);
    expect(runs.reduce((n, r) => n + r.count, 0)).toBe(5);
  });
});
