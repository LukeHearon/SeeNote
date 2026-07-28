import { getSpectrogramChunkRange } from './utils/tauriCommands';
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

/**
 * Pull the longest contiguous run of chunk indices containing the queue head
 * (same tier, at most `maxLen` chunks) out of `queue`, mutating it.
 *
 * Chunks are queued centre-out, so the head is the highest-priority chunk and
 * the run grows around it — forward first, since a range is walked forward and
 * the forward neighbour is the next-highest priority. Returns null for an empty
 * queue.
 */
export function takeContiguousRun(
  queue: Array<{ tier: number; chunkIndex: number }>,
  maxLen: number,
): { tier: number; firstIndex: number; count: number } | null {
  if (queue.length === 0) return null;
  const { tier, chunkIndex: head } = queue[0];

  const queued = new Set<number>();
  for (const item of queue) if (item.tier === tier) queued.add(item.chunkIndex);

  let lo = head;
  let hi = head;
  while (hi - lo + 1 < maxLen) {
    if (queued.has(hi + 1)) hi++;
    else if (queued.has(lo - 1)) lo--;
    else break;
  }

  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (item.tier === tier && item.chunkIndex >= lo && item.chunkIndex <= hi) {
      queue.splice(i, 1);
    }
  }
  return { tier, firstIndex: lo, count: hi - lo + 1 };
}

export class MultiTierSpectrogramCache {
  private tiers: TierConfig[];
  private tierByNumber: Map<number, TierConfig>; // tier number -> tier config
  private caches: Map<number, Map<number, CachedChunk>>; // tier -> (chunkIdx -> chunk)
  // Cap concurrent Tauri IPC/FFT calls so the first chunks in view complete
  // quickly rather than all chunks competing for CPU simultaneously.
  private static readonly MAX_CONCURRENT = 4;
  private inFlight = new Set<string>(); // "tier:chunkIdx" currently being fetched
  // MAX_CONCURRENT limits REQUESTS, not chunks: one request may cover a
  // contiguous run of chunks (see drainQueue).
  private activeRequests = 0;
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
      this.activeRequests < MultiTierSpectrogramCache.MAX_CONCURRENT &&
      this.fetchQueue.length > 0
    ) {
      const freeSlots = MultiTierSpectrogramCache.MAX_CONCURRENT - this.activeRequests;
      // Spread the queued chunks over the free slots. With few chunks each slot
      // takes one, which is the fastest arrangement when cores are free: the
      // backend computes them in parallel. With many, each slot instead walks a
      // contiguous run in ONE pass, because every separate chunk request re-opens
      // the file and a container open scans from byte 0 to the chunk's start —
      // twelve chunks deep in a 50h file re-scan gigabytes between them.
      //
      // Measured on a 49.7h MP3 (see coarse_bench::range_walk_vs_parallel_chunks),
      // 4 chunks: 4 parallel requests 0.57s, one 4-chunk walk 1.37s. Batching
      // only pays once there are more chunks than slots, so the split keeps
      // parallelism maxed first and batches only the excess.
      const maxRunLength = Math.max(1, Math.ceil(this.fetchQueue.length / freeSlots));
      const run = takeContiguousRun(this.fetchQueue, maxRunLength);
      if (!run) break;
      this.dispatchRange(run.tier, run.firstIndex, run.count);
    }
  }

  private dispatchRange(tier: number, firstIndex: number, count: number): void {
    const cache = this.caches.get(tier);
    const tierConfig = this.tierByNumber.get(tier);
    if (!cache || !tierConfig) return;

    const keys: string[] = [];
    for (let i = 0; i < count; i++) keys.push(`${tier}:${firstIndex + i}`);
    for (const key of keys) this.inFlight.add(key);
    this.activeRequests += 1;
    const generation = this.generationId;

    getSpectrogramChunkRange(
      this.filePath,
      firstIndex,
      count,
      tierConfig.chunkDuration,
      this.fftSize,
      tierConfig.hopSize,
      result => {
        // Discard if invalidate() was called while this request was in flight.
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
        cache.set(result.chunk_index, chunk);
        // Fires per chunk, not per request, so the view fills in progressively
        // while a multi-chunk walk is still running.
        this.onChunkLoaded();
      },
    )
      .catch(err => {
        console.error(
          `MultiTierCache: failed to fetch tier ${tier} chunks ${firstIndex}..${firstIndex + count - 1}:`,
          err,
        );
      })
      .finally(() => {
        for (const key of keys) this.inFlight.delete(key);
        this.activeRequests -= 1;
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
    this.activeRequests = 0;
    this.fetchQueue = [];
    this.activeTierIndex = -1;
  }
}
