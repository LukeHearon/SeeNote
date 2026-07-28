import { getSpectrogramChunk } from './utils/tauriCommands';
import { buildTierLadder, TierConfig } from './constants';

export interface CachedChunk {
  data: Uint16Array;
  nCols: number;
  nFreqBins: number;
  startSec: number;
  actualDurationSec: number;
  sampleRate: number;
  lastAccessed: number;
}

/**
 * Retire the cache currently held in `ref` and install `next` in its place
 * (pass null to just drop the current one).
 *
 * Retiring matters on a track switch: the outgoing cache's queued/in-flight
 * fetches otherwise keep issuing FFT work for the file the user just left,
 * competing for CPU with the incoming track's chunks and firing onChunkLoaded
 * long after its data stopped being displayable. invalidate() drops its queue,
 * clears its chunks, and bumps its generation so late results are discarded.
 *
 * Every cache swap goes through here so the teardown can't be forgotten at one
 * of the call sites.
 */
export function swapChunkCache(
  ref: { current: MultiTierSpectrogramCache | null },
  next: MultiTierSpectrogramCache | null,
): void {
  if (ref.current && ref.current !== next) ref.current.invalidate();
  ref.current = next;
}

export class MultiTierSpectrogramCache {
  private tiers: TierConfig[];
  private tierByNumber: Map<number, TierConfig>; // tier number -> tier config
  private caches: Map<number, Map<number, CachedChunk>>; // tier -> (chunkIdx -> chunk)
  // Cap concurrent Tauri IPC/FFT calls so the first chunks in view complete
  // quickly rather than all chunks competing for CPU simultaneously.
  private static readonly MAX_CONCURRENT = 4;
  private inFlight = new Set<string>(); // "tier:chunkIdx" currently being fetched
  private fetchQueue: Array<{ tier: number; chunkIndex: number }> = [];
  private activeTierIndex: number = -1; // for hysteresis
  // Bumped on every invalidate() so in-flight fetches can detect staleness.
  private generationId: number = 0;

  constructor(
    private readonly filePath: string,
    private readonly fftSize: number,
    private readonly sampleRate: number,
    private readonly duration: number,
    private readonly onChunkLoaded: () => void,
  ) {
    // Build the ladder for THIS file: its length depends on the duration, so a
    // short clip gets only the fine tiers it can use and a long recording gets
    // coarse tiers all the way down to a whole-file view. See buildTierLadder.
    //
    // NOTE: hop sizes are exact powers of two in samples, so colsPerSec is not
    // rounded. Even if it were, all downstream time math uses the *reported*
    // `chunk.actualDurationSec` / `chunk.nCols` rather than a reconstructed
    // column spacing, and annotations are stored in absolute seconds and never
    // round-trip through column indices.
    this.tiers = buildTierLadder(sampleRate, duration, fftSize);

    // Index tiers by their tier number for O(1) lookup.
    this.tierByNumber = new Map(this.tiers.map(t => [t.tier, t]));

    // Initialize per-tier caches
    this.caches = new Map();
    for (const t of this.tiers) {
      this.caches.set(t.tier, new Map());
    }
  }

  // ── Tier selection ──────────────────────────────────────────────────────────

  /**
   * Select the best tier for the current zoom level.
   * Picks the coarsest tier where we have at least 1 data column per pixel.
   * Uses hysteresis to avoid rapid tier switching at boundaries.
   */
  selectTier(visibleDuration: number, canvasWidth: number): TierConfig {
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
    const tierConfig = this.tierByNumber.get(tier);
    if (!tierConfig) return null;
    const idx = Math.floor(timeSec / tierConfig.chunkDuration);
    const cache = this.caches.get(tier);
    if (!cache) return null;
    const chunk = cache.get(idx);
    if (chunk) {
      // Move to end of insertion order so Map iteration gives true LRU at front.
      chunk.lastAccessed = Date.now();
      cache.delete(idx);
      cache.set(idx, chunk);
      return chunk;
    }
    return null;
  }

  /**
   * Try to get a chunk at the preferred tier; fall back to coarser tiers first
   * (a blurry placeholder beats a hole), then to finer ones that may still be
   * cached from a previous zoom level.
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

    return null;
  }

  // ── Build-progress probes (read-only) ─────────────────────────────────────────
  // These never mutate hysteresis or LRU state, so they are safe to call from a
  // React render / draw pass to drive a "building spectrogram" indicator.

  /** Number of chunk fetches in flight or queued (across all tiers). */
  pendingCount(): number {
    return this.inFlight.size + this.fetchQueue.length;
  }

  /**
   * True once every chunk index spanning [startTime, endTime] is cached at the
   * given tier — i.e. the visible range can be drawn sharp without falling back
   * to a coarser tier. Mirrors prefetchViewport's index range exactly. Does NOT
   * touch LRU order (uses cache.has, not getChunkForTime).
   */
  isViewportResolved(startTime: number, endTime: number, tier: number): boolean {
    const tierConfig = this.tierByNumber.get(tier);
    const cache = this.caches.get(tier);
    if (!tierConfig || !cache) return false;

    const firstIdx = Math.max(0, Math.floor(startTime / tierConfig.chunkDuration) - 1);
    const lastIdx = Math.floor(endTime / tierConfig.chunkDuration) + 1;

    for (let idx = firstIdx; idx <= lastIdx; idx++) {
      // Chunks whose start is past the file end are never fetched, so they
      // can't be "missing" — skip them.
      if (idx * tierConfig.chunkDuration >= this.duration) break;
      if (!cache.has(idx)) return false;
    }
    return true;
  }

  // ── Prefetching ─────────────────────────────────────────────────────────────

  prefetchViewport(startTime: number, endTime: number, tier: number): void {
    const tierConfig = this.tierByNumber.get(tier);
    if (!tierConfig) return;

    const firstIdx = Math.max(0, Math.floor(startTime / tierConfig.chunkDuration) - 1);
    const lastIdx = Math.floor(endTime / tierConfig.chunkDuration) + 1;
    const cache = this.caches.get(tier);

    // Build center-out ordered list so the chunk under the viewport center
    // (and playhead) renders first, expanding outward.
    const centerIdx = Math.round((firstIdx + lastIdx) / 2);
    const ordered: Array<{ tier: number; chunkIndex: number }> = [];
    let lo = centerIdx, hi = centerIdx + 1;
    while (lo >= firstIdx || hi <= lastIdx) {
      if (lo >= firstIdx) ordered.push({ tier, chunkIndex: lo-- });
      if (hi <= lastIdx) ordered.push({ tier, chunkIndex: hi++ });
    }

    // Replace queue with new viewport, skipping already-cached or in-flight chunks.
    // In-flight fetches continue undisturbed; stale queued items are dropped.
    this.fetchQueue = ordered.filter(({ tier: t, chunkIndex }) => {
      const key = `${t}:${chunkIndex}`;
      const startSec = chunkIndex * tierConfig.chunkDuration;
      return startSec < this.duration && !cache?.has(chunkIndex) && !this.inFlight.has(key);
    });

    this.drainQueue();
  }

  // ── Internal fetch/cache ────────────────────────────────────────────────────

  private drainQueue(): void {
    while (
      this.inFlight.size < MultiTierSpectrogramCache.MAX_CONCURRENT &&
      this.fetchQueue.length > 0
    ) {
      const next = this.fetchQueue.shift()!;
      const key = `${next.tier}:${next.chunkIndex}`;
      const cache = this.caches.get(next.tier);
      // Re-check: may have been cached by a concurrent in-flight fetch.
      if (cache?.has(next.chunkIndex) || this.inFlight.has(key)) continue;
      this.dispatchFetch(next.tier, next.chunkIndex);
    }
  }

  private dispatchFetch(tier: number, chunkIndex: number): void {
    const key = `${tier}:${chunkIndex}`;
    const cache = this.caches.get(tier);
    if (!cache || cache.has(chunkIndex) || this.inFlight.has(key)) return;

    const tierConfig = this.tierByNumber.get(tier);
    if (!tierConfig) return;

    const startSec = chunkIndex * tierConfig.chunkDuration;
    if (startSec >= this.duration) return;

    this.inFlight.add(key);
    const generation = this.generationId;

    getSpectrogramChunk(
      this.filePath,
      startSec,
      tierConfig.chunkDuration,
      this.fftSize,
      tierConfig.hopSize,
    )
      .then(result => {
        // Discard result if invalidate() was called while this fetch was in flight.
        if (this.generationId !== generation) return;

        const chunk: CachedChunk = {
          data: result.data,
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
        this.inFlight.delete(key);
        this.drainQueue();
      });
  }

  private evictLRU(tier: number): void {
    const tierConfig = this.tierByNumber.get(tier);
    const cache = this.caches.get(tier);
    if (!tierConfig || !cache || cache.size < tierConfig.maxChunks) return;

    // Because getChunkForTime() moves every hit to the end of the Map via
    // delete+set, the first key in insertion order is always the true LRU.
    const lruKey = cache.keys().next().value;
    if (lruKey !== undefined) cache.delete(lruKey);
  }

  /** Clears all cached data (call when fftSize changes). */
  invalidate(): void {
    // Bump generation so any in-flight fetches discard their results.
    this.generationId += 1;
    for (const cache of this.caches.values()) {
      cache.clear();
    }
    this.inFlight.clear();
    this.fetchQueue = [];
    this.activeTierIndex = -1;
  }
}
