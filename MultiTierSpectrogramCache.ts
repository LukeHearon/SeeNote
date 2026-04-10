import { getSpectrogramChunk, getOverviewSpectrogram } from './utils/tauriCommands';
import { TIER_CONFIGS, TierConfig } from './constants';

export interface CachedChunk {
  data: Uint8Array;
  nCols: number;
  nFreqBins: number;
  startSec: number;
  actualDurationSec: number;
  sampleRate: number;
  lastAccessed: number;
}

interface ResolvedTier {
  tier: number;
  hopSize: number;         // resolved hop in samples
  colsPerSec: number;      // sampleRate / hopSize
  chunkDuration: number;
  maxChunks: number;
}

export class MultiTierSpectrogramCache {
  private tiers: ResolvedTier[];
  private caches: Map<number, Map<number, CachedChunk>>; // tier -> (chunkIdx -> chunk)
  private pending = new Set<string>(); // "tier:chunkIdx"
  private activeTierIndex: number = -1; // for hysteresis
  private ultraOverview: CachedChunk | null = null;

  constructor(
    private readonly filePath: string,
    private readonly fftSize: number,
    private readonly sampleRate: number,
    private readonly duration: number,
    private readonly onChunkLoaded: () => void,
  ) {
    // Resolve tier configs into concrete hop sizes.
    // NOTE: Math.round() here is benign for sample-accuracy. The hop size
    // determines the STFT column grid WITHIN a chunk, and all downstream
    // time math uses `chunk.actualDurationSec` + `chunk.nCols` (i.e. the
    // *reported* column spacing, not a reconstructed one), so a 1-sample
    // rounding in hopSize does not shift annotations or playhead.
    // Annotations are stored in absolute seconds and never round-trip
    // through column indices.
    this.tiers = TIER_CONFIGS.map(tc => {
      const hopSize = tc.hopSamples ?? Math.round(sampleRate * (tc.hopMultiplier ?? 1));
      return {
        tier: tc.tier,
        hopSize,
        colsPerSec: sampleRate / hopSize,
        chunkDuration: tc.chunkDuration,
        maxChunks: tc.maxChunks,
      };
    });

    // Initialize per-tier caches
    this.caches = new Map();
    for (const t of this.tiers) {
      this.caches.set(t.tier, new Map());
    }

    // Preload ultra-overview (whole file, ~1200 columns)
    this.loadUltraOverview();
  }

  // ── Tier selection ──────────────────────────────────────────────────────────

  /**
   * Select the best tier for the current zoom level.
   * Picks the coarsest tier where we have at least 1 data column per pixel.
   * Uses hysteresis to avoid rapid tier switching at boundaries.
   */
  selectTier(visibleDuration: number, canvasWidth: number): ResolvedTier {
    const pixelsPerSec = canvasWidth / visibleDuration;

    // Find the coarsest tier with >= 1 column per pixel
    let bestIdx = this.tiers.length - 1; // default to finest
    for (let i = 0; i < this.tiers.length; i++) {
      if (this.tiers[i].colsPerSec >= pixelsPerSec) {
        bestIdx = i;
        break;
      }
    }

    // Hysteresis: stay on current tier unless we've moved 20% past the boundary
    if (this.activeTierIndex >= 0 && this.activeTierIndex !== bestIdx) {
      const currentTier = this.tiers[this.activeTierIndex];
      const ratio = currentTier.colsPerSec / pixelsPerSec;
      // Stay on current tier if it's still within a reasonable range (0.5x to 3x)
      if (ratio >= 0.5 && ratio <= 3.0) {
        return currentTier;
      }
    }

    this.activeTierIndex = bestIdx;
    return this.tiers[bestIdx];
  }

  // ── Chunk access ────────────────────────────────────────────────────────────

  getChunkForTime(tier: number, timeSec: number): CachedChunk | null {
    const tierConfig = this.tiers.find(t => t.tier === tier);
    if (!tierConfig) return null;
    const idx = Math.floor(timeSec / tierConfig.chunkDuration);
    const cache = this.caches.get(tier);
    if (!cache) return null;
    const chunk = cache.get(idx);
    if (chunk) {
      chunk.lastAccessed = Date.now();
      return chunk;
    }
    return null;
  }

  /**
   * Try to get a chunk at the preferred tier; fall back to coarser tiers.
   * Returns the ultra-overview as last resort.
   */
  getChunkWithFallback(timeSec: number, preferredTier: number): { chunk: CachedChunk; tier: number } | null {
    // Try preferred tier first
    const chunk = this.getChunkForTime(preferredTier, timeSec);
    if (chunk) return { chunk, tier: preferredTier };

    // Fall back to coarser tiers (lower tier numbers = coarser)
    for (let i = preferredTier - 1; i >= 0; i--) {
      const fallback = this.getChunkForTime(i, timeSec);
      if (fallback) return { chunk: fallback, tier: i };
    }

    // Fall back to finer tiers (already cached from previous zoom levels)
    for (let i = preferredTier + 1; i < this.tiers.length; i++) {
      const fallback = this.getChunkForTime(i, timeSec);
      if (fallback) return { chunk: fallback, tier: i };
    }

    // Last resort: ultra-overview
    if (this.ultraOverview) {
      return { chunk: this.ultraOverview, tier: -1 };
    }

    return null;
  }

  // ── Prefetching ─────────────────────────────────────────────────────────────

  prefetchViewport(startTime: number, endTime: number, tier: number): void {
    const tierConfig = this.tiers.find(t => t.tier === tier);
    if (!tierConfig) return;

    const firstIdx = Math.max(0, Math.floor(startTime / tierConfig.chunkDuration) - 1);
    const lastIdx = Math.floor(endTime / tierConfig.chunkDuration) + 1;

    for (let idx = firstIdx; idx <= lastIdx; idx++) {
      this.fetchChunkIfNeeded(tier, idx);
    }
  }

  // ── Internal fetch/cache ────────────────────────────────────────────────────

  private fetchChunkIfNeeded(tier: number, chunkIndex: number): void {
    const key = `${tier}:${chunkIndex}`;
    const cache = this.caches.get(tier);
    if (!cache || cache.has(chunkIndex) || this.pending.has(key)) return;

    const tierConfig = this.tiers.find(t => t.tier === tier);
    if (!tierConfig) return;

    const startSec = chunkIndex * tierConfig.chunkDuration;
    if (startSec >= this.duration) return;

    this.pending.add(key);

    getSpectrogramChunk(
      this.filePath,
      startSec,
      tierConfig.chunkDuration,
      this.fftSize,
      tierConfig.hopSize,
    )
      .then(result => {
        const chunk: CachedChunk = {
          data: new Uint8Array(result.data),
          nCols: result.n_cols,
          nFreqBins: result.n_freq_bins,
          startSec: result.start_sec,
          actualDurationSec: result.actual_duration_sec,
          sampleRate: result.sample_rate,
          lastAccessed: Date.now(),
        };

        this.evictLRU(tier);
        cache.set(chunkIndex, chunk);
        this.onChunkLoaded();
      })
      .catch(err => {
        console.error(`MultiTierCache: failed to fetch tier ${tier} chunk ${chunkIndex}:`, err);
      })
      .finally(() => {
        this.pending.delete(key);
      });
  }

  private evictLRU(tier: number): void {
    const tierConfig = this.tiers.find(t => t.tier === tier);
    const cache = this.caches.get(tier);
    if (!tierConfig || !cache || cache.size < tierConfig.maxChunks) return;

    let oldestTime = Infinity;
    let oldestKey = -1;
    for (const [k, v] of cache) {
      if (v.lastAccessed < oldestTime) {
        oldestTime = v.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey >= 0) cache.delete(oldestKey);
  }

  private async loadUltraOverview(): Promise<void> {
    try {
      // Request ~1200 columns for the whole file — enough for any screen width
      const nColumns = Math.min(1200, Math.ceil(this.duration));
      if (nColumns <= 0) return;

      const result = await getOverviewSpectrogram(this.filePath, nColumns, this.fftSize);
      this.ultraOverview = {
        data: new Uint8Array(result.data),
        nCols: result.n_cols,
        nFreqBins: result.n_freq_bins,
        startSec: 0,
        actualDurationSec: result.actual_duration_sec,
        sampleRate: result.sample_rate,
        lastAccessed: Date.now(),
      };
      this.onChunkLoaded();
    } catch (err) {
      console.error('MultiTierCache: failed to load ultra-overview:', err);
    }
  }

  /** Clears all cached data (call when fftSize changes). */
  invalidate(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
    this.pending.clear();
    this.ultraOverview = null;
    this.activeTierIndex = -1;
    this.loadUltraOverview();
  }
}
