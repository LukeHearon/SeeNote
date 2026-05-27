import { describe, it, expect } from 'vitest';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { TIER_CONFIGS } from '../constants';

// ── Test scaffolding ─────────────────────────────────────────────────────────
//
// We only exercise `selectTier()`, which is a pure function of the resolved
// tier table built in the constructor plus the internal `activeTierIndex`
// (hysteresis state). The constructor also kicks off `loadUltraOverview()`,
// which invokes a Tauri IPC command. In the node test environment that call
// rejects and is swallowed by the catch inside `loadUltraOverview` — so
// instantiation is safe without stubbing anything. We do NOT fake IndexedDB
// or Tauri IPC; we just don't touch any code path that depends on a fetched
// chunk.
//
// With the canonical TIER_CONFIGS and sampleRate = 48000:
//   tier 0: hopMultiplier 1.0   → hopSize 48000 → colsPerSec  1
//   tier 1: hopMultiplier 0.1   → hopSize  4800 → colsPerSec 10
//   tier 2: hopSamples    1024  → hopSize  1024 → colsPerSec ≈ 46.875
//   tier 3: hopSamples     512  → hopSize   512 → colsPerSec   93.75
//
// `selectTier` picks the FIRST tier (coarsest, lowest index) whose colsPerSec
// is ≥ pixelsPerSec = canvasWidth / visibleDuration. If none qualifies, it
// falls back to the finest tier (last index).

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;
const DURATION = 3600; // 1 hour

function makeCache(): MultiTierSpectrogramCache {
  // onChunkLoaded is a no-op; the only async work the constructor starts is
  // loadUltraOverview(), which will reject internally and be caught.
  return new MultiTierSpectrogramCache(
    '/nonexistent/test.wav',
    FFT_SIZE,
    SAMPLE_RATE,
    DURATION,
    () => {},
  );
}

// Sanity-check our derivations match the source-of-truth tier configs.
describe('TIER_CONFIGS sanity', () => {
  it('has 4 tiers ordered coarsest-to-finest', () => {
    expect(TIER_CONFIGS).toHaveLength(4);
    expect(TIER_CONFIGS.map(t => t.tier)).toEqual([0, 1, 2, 3]);
  });
});

describe('MultiTierSpectrogramCache.selectTier', () => {
  it('returns the coarsest tier (tier 0) when the full file is visible', () => {
    const cache = makeCache();
    // visibleDuration = 3600s, canvasWidth = 1000 → 0.278 px/s.
    // Tier 0's colsPerSec = 1 ≥ 0.278, so tier 0 wins.
    const t = cache.selectTier(DURATION, 1000);
    expect(t.tier).toBe(0);
  });

  it('returns the finest tier (tier 3) for extremely high zoom', () => {
    const cache = makeCache();
    // visibleDuration = 0.1s, canvasWidth = 1000 → 10000 px/s.
    // No tier has colsPerSec ≥ 10000, so bestIdx falls through to the last
    // (finest) tier.
    const t = cache.selectTier(0.1, 1000);
    expect(t.tier).toBe(3);
  });

  it('returns tier 1 when pixelsPerSec is just at its boundary (10 px/s)', () => {
    const cache = makeCache();
    // visibleDuration = 100s, canvasWidth = 1000 → exactly 10 px/s.
    // Tier 1 colsPerSec = 10 ≥ 10 → tier 1.
    const t = cache.selectTier(100, 1000);
    expect(t.tier).toBe(1);
  });

  it('steps from tier 1 to tier 2 when pixelsPerSec crosses just above 10', () => {
    const cache = makeCache();
    // First call: 10 px/s lands on tier 1 (and sets activeTierIndex=1).
    expect(cache.selectTier(100, 1000).tier).toBe(1);

    // Now pixelsPerSec = 1000/99 ≈ 10.10. Tier 1's 10 < 10.10, so bestIdx
    // advances to tier 2 (46.875 ≥ 10.10).
    //
    // Hysteresis check: ratio = currentTier.colsPerSec / pixelsPerSec
    //                        = 10 / 10.10 ≈ 0.99, which is in [0.5, 3.0],
    // so hysteresis HOLDS us on tier 1.
    //
    // To actually step up to tier 2 we need to push ratio below 0.5,
    // i.e. pixelsPerSec > 20.
    const held = cache.selectTier(99, 1000);
    expect(held.tier).toBe(1);

    // pixelsPerSec = 1000/40 = 25 → ratio 10/25 = 0.4 < 0.5 → release.
    const stepped = cache.selectTier(40, 1000);
    expect(stepped.tier).toBe(2);
  });

  it('hysteresis: a small zoom change does NOT thrash tiers', () => {
    const cache = makeCache();
    // Land on tier 2: pixelsPerSec = 30, tier 2 colsPerSec ≈ 46.875 ≥ 30.
    // (Tier 1 fails: 10 < 30.) So bestIdx = 2.
    expect(cache.selectTier(1000 / 30, 1000).tier).toBe(2);

    // Slight zoom-in: pixelsPerSec = 60 → bestIdx would become tier 3
    // (93.75 ≥ 60, 46.875 < 60). But ratio = 46.875 / 60 = 0.78, within
    // [0.5, 3.0] → stay on tier 2.
    const t = cache.selectTier(1000 / 60, 1000);
    expect(t.tier).toBe(2);
  });

  it('hysteresis: a small zoom-OUT does not thrash tiers either', () => {
    const cache = makeCache();
    // Land on tier 2 at pixelsPerSec = 30.
    expect(cache.selectTier(1000 / 30, 1000).tier).toBe(2);

    // Zoom out slightly: pixelsPerSec = 15. Now tier 1 (colsPerSec 10) still
    // fails — wait, 10 < 15, so tier 2 is still the best fit anyway. Pick
    // a value where bestIdx would drop to tier 1: pixelsPerSec = 8 → tier 1
    // qualifies (10 ≥ 8). But ratio = 46.875 / 8 ≈ 5.86, which is > 3.0 →
    // hysteresis releases and we move to the new best (tier 1).
    //
    // To get a "small" zoom-out that hysteresis SHOULD absorb, use
    // pixelsPerSec = 20: tier 1 fails (10 < 20), tier 2 still wins → no
    // tier change to absorb. Use pixelsPerSec = 9: tier 1 wins (10 ≥ 9),
    // ratio = 46.875 / 9 ≈ 5.21 > 3.0 → also releases. The 3.0 ceiling
    // means zooming out aggressively enough to actually pick a coarser
    // tier will always release. So instead, just confirm that a zoom-out
    // that doesn't change bestIdx leaves us put.
    const t = cache.selectTier(1000 / 25, 1000); // pps=25, tier 2 best
    expect(t.tier).toBe(2);
  });

  it('hysteresis releases on a large zoom change (ratio outside [0.5, 3.0])', () => {
    const cache = makeCache();
    // Land on tier 1: pixelsPerSec = 5 → tier 1 (10 ≥ 5) wins (tier 0 also
    // qualifies? no: tier 0 colsPerSec = 1, 1 < 5, so tier 0 fails; tier 1
    // is the first/coarsest that qualifies).
    expect(cache.selectTier(1000 / 5, 1000).tier).toBe(1);

    // Big zoom-in: pixelsPerSec = 50 → bestIdx = tier 3 (93.75 ≥ 50, 46.875
    // < 50). Ratio = 10/50 = 0.2 < 0.5 → release, switch to tier 3.
    const t = cache.selectTier(1000 / 50, 1000);
    expect(t.tier).toBe(3);
  });

  it('hysteresis releases on a large zoom-out (ratio > 3.0)', () => {
    const cache = makeCache();
    // Land on tier 3: pixelsPerSec = 60 → tier 3 wins (93.75 ≥ 60, 46.875<60).
    expect(cache.selectTier(1000 / 60, 1000).tier).toBe(3);

    // Big zoom-out: pixelsPerSec = 5 → bestIdx = tier 1 (10 ≥ 5).
    // Ratio = currentTier(3).colsPerSec / pps = 93.75 / 5 = 18.75 > 3.0 → release.
    const t = cache.selectTier(1000 / 5, 1000);
    expect(t.tier).toBe(1);
  });

  it('returned tier exposes resolved hopSize and colsPerSec consistent with sampleRate', () => {
    const cache = makeCache();
    const t = cache.selectTier(DURATION, 1000); // tier 0
    expect(t.hopSize).toBe(SAMPLE_RATE); // hopMultiplier 1.0
    expect(t.colsPerSec).toBeCloseTo(SAMPLE_RATE / t.hopSize, 10);
    expect(t.chunkDuration).toBe(TIER_CONFIGS[0].chunkDuration);
    expect(t.maxChunks).toBe(TIER_CONFIGS[0].maxChunks);
  });

  it('first call (no prior activeTierIndex) picks the pure-best tier without hysteresis', () => {
    const cache = makeCache();
    // At pixelsPerSec = 60, pure-best is tier 3. With no prior tier set
    // (activeTierIndex = -1), hysteresis is bypassed and we go straight to 3.
    expect(cache.selectTier(1000 / 60, 1000).tier).toBe(3);
  });
});
