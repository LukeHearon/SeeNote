import { describe, it, expect } from 'vitest';
import { MultiTierSpectrogramCache, swapChunkCache } from '../MultiTierSpectrogramCache';
import {
  buildTierLadder,
  COLS_PER_CHUNK,
  FINEST_HOP_SAMPLES,
  OVERVIEW_TARGET_COLS,
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
