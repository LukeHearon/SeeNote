import { getSpectrogramChunkRange } from './utils/tauriCommands';
import { buildTierLadder, TierConfig } from './constants';

export interface CachedChunk {
  data: Uint16Array;
  nCols: number;
  nFreqBins: number;
  startSec: number;
  actualDurationSec: number;
  sampleRate: number;
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

/**
 * The chunk indices covering `ranges` at a tier's `chunkDuration`, deduped and
 * sorted. Ranges are SOURCE-time ranges: under a subset one screenful is
 * several disjoint stretches of the file, and two of them often land in the
 * same chunk, so the dedup matters.
 *
 * `pad` extends the span by one chunk on each side — scroll margin, so panning
 * doesn't stall at the edge. It only applies to a single contiguous range. Under
 * a subset the thing you scroll into next is the NEXT SPAN, not the file time
 * adjacent to this span, so padding every span would triple the fetch and cache
 * pressure for chunks that will never be shown (a one-second span at the finest
 * tier is one chunk; padded it is three).
 *
 * Shared by prefetchRanges and isViewportResolvedForRanges so "what the viewport
 * needs" is defined in exactly one place.
 */
export function chunkIndicesForRanges(
  ranges: readonly { start: number; end: number }[],
  chunkDuration: number,
  sourceDuration: number,
  pad: boolean,
): number[] {
  const indices = new Set<number>();
  for (const r of ranges) {
    const first = Math.max(0, Math.floor(r.start / chunkDuration) - (pad ? 1 : 0));
    const last = Math.floor(r.end / chunkDuration) + (pad ? 1 : 0);
    for (let idx = first; idx <= last; idx++) {
      // Chunks starting past the end of the file are never fetched.
      if (idx * chunkDuration >= sourceDuration) break;
      indices.add(idx);
    }
  }
  return [...indices].sort((a, b) => a - b);
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
  // Chunks the current viewport is drawing from — exempt from LRU eviction.
  // One tier at a time: only the active tier is prefetched, and stale pins on a
  // tier the view has left must not keep its chunks alive forever.
  private pinnedTier: number = -1;
  private pinnedIndices = new Set<number>();
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

  /**
   * Read-only: does NOT reorder the LRU. The renderer calls this once per
   * offscreen COLUMN per frame — thousands of times — and the delete+set pair
   * that used to mark recency here cost two Map mutations and a Date.now() on
   * every one of them. Recency is instead marked once per frame, per chunk, by
   * prefetchRanges (see touchViewport), which is a truer signal anyway: "this
   * chunk is in the viewport", not "some column happened to sample it".
   */
  getChunkForTime(tier: number, timeSec: number): CachedChunk | null {
    const tierConfig = this.tierByNumber.get(tier);
    if (!tierConfig) return null;
    const cache = this.caches.get(tier);
    if (!cache) return null;
    return cache.get(Math.floor(timeSec / tierConfig.chunkDuration)) ?? null;
  }

  /**
   * Mark the viewport's chunks as most-recently-used by reinserting them at the
   * end of the Map, so iteration order stays true LRU for evictLRU.
   */
  private touchViewport(cache: Map<number, CachedChunk>, indices: readonly number[]): void {
    for (const idx of indices) {
      const chunk = cache.get(idx);
      if (chunk === undefined) continue;
      cache.delete(idx);
      cache.set(idx, chunk);
    }
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
   * True once every chunk the source ranges need is cached at the given tier —
   * i.e. the visible range can be drawn sharp without falling back to a coarser
   * tier. Shares its index set with prefetchRanges. Does NOT touch LRU order
   * (uses cache.has, not getChunkForTime).
   */
  isViewportResolvedForRanges(
    ranges: readonly { start: number; end: number }[],
    tier: number,
  ): boolean {
    const tierConfig = this.tierByNumber.get(tier);
    const cache = this.caches.get(tier);
    if (!tierConfig || !cache) return false;
    const indices = chunkIndicesForRanges(
      ranges, tierConfig.chunkDuration, this.duration, ranges.length === 1,
    );
    return indices.every(idx => cache.has(idx));
  }

  /** Single-range convenience wrapper (no subset in play). */
  isViewportResolved(startTime: number, endTime: number, tier: number): boolean {
    return this.isViewportResolvedForRanges([{ start: startTime, end: endTime }], tier);
  }

  // ── Prefetching ─────────────────────────────────────────────────────────────

  /**
   * Queue everything the viewport needs, where "the viewport" may be several
   * disjoint stretches of the file (one per subset span on screen).
   *
   * All ranges go into ONE queue in one call. They cannot be prefetched one at a
   * time: each call replaces the queue, so a per-range loop had every span but
   * the last wipe the span before it, and only the handful of chunks that
   * happened to dispatch during that call's drain were ever fetched. The rest
   * silently never loaded, which is what made individual subset segments render
   * blank, blurry (coarse-tier fallback), or flicker as which span won the race
   * changed frame to frame.
   */
  prefetchRanges(ranges: readonly { start: number; end: number }[], tier: number): void {
    const tierConfig = this.tierByNumber.get(tier);
    if (!tierConfig) return;
    const cache = this.caches.get(tier);

    const indices = chunkIndicesForRanges(
      ranges, tierConfig.chunkDuration, this.duration, ranges.length === 1,
    );

    // Everything on screen is pinned against eviction until the next prefetch.
    // See evictLRU: a scattered subset viewport can need more chunks than the
    // per-tier budget holds, and evicting a chunk that is still visible to make
    // room for another one that is also still visible just thrashes.
    this.pinnedTier = tier;
    this.pinnedIndices = new Set(indices);
    if (cache) this.touchViewport(cache, indices);

    // Order the fetch.
    //
    // Contiguous view: center-out, so the chunk under the viewport center (and
    // playhead) renders first and the view fills outward from where the user is
    // looking. Its chunks are neighbours in the file, so this costs nothing.
    //
    // Subset view: ascending file order instead. These chunks are scattered
    // across the recording, and Rust's stream pool can only reuse an open
    // stream positioned AT OR BEFORE the chunk it's asked for — a backward seek
    // restarts the container scan from byte 0, which is ~300ms a chunk deep into
    // a 50h MP3 (see src-tauri/src/audio/stream_pool.rs). Center-out alternates
    // around the middle, so roughly half the requests seek backwards and pay
    // that in full; ascending order chains them into short forward seeks. With
    // twenty tiny segments on screen the fill order barely reads as different,
    // and the scan cost dominates everything else about how fast it appears.
    const ordered: Array<{ tier: number; chunkIndex: number }> = [];
    if (ranges.length === 1) {
      const center = indices.length >> 1;
      let lo = center - 1, hi = center;
      while (lo >= 0 || hi < indices.length) {
        if (hi < indices.length) ordered.push({ tier, chunkIndex: indices[hi++] });
        if (lo >= 0) ordered.push({ tier, chunkIndex: indices[lo--] });
      }
    } else {
      for (const chunkIndex of indices) ordered.push({ tier, chunkIndex });
    }

    // Replace queue with new viewport, skipping already-cached or in-flight chunks.
    // In-flight fetches continue undisturbed; stale queued items are dropped.
    this.fetchQueue = ordered.filter(({ tier: t, chunkIndex }) =>
      !cache?.has(chunkIndex) && !this.inFlight.has(`${t}:${chunkIndex}`),
    );

    this.drainQueue();
  }

  /** Single-range convenience wrapper (no subset in play). */
  prefetchViewport(startTime: number, endTime: number, tier: number): void {
    this.prefetchRanges([{ start: startTime, end: endTime }], tier);
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
    if (!tierConfig || !cache) return;
    const pinned = tier === this.pinnedTier ? this.pinnedIndices : null;

    // Because getChunkForTime() moves every hit to the end of the Map via
    // delete+set, the first key in insertion order is always the true LRU.
    //
    // Chunks the current viewport needs are skipped. A subset viewport scattered
    // across the file can require more chunks at once than the byte budget
    // allows (a 16MB / 2MB-per-chunk tier holds 8; twenty visible segments in
    // twenty different parts of the file need twenty). Evicting one of those to
    // fetch another only to have IT evicted on the next arrival is a loop with
    // no fixed point: every chunk lands, gets drawn, and is thrown out before the
    // next frame — segments blinking out and dropping to a coarser fallback tier
    // at random, changing with zoom because zoom changes how many segments fit.
    // So the cap yields to what is on screen; the ceiling is then the viewport,
    // which is bounded, and it drops back to the budget as soon as the pins move.
    while (cache.size >= tierConfig.maxChunks) {
      let victim: number | undefined;
      for (const key of cache.keys()) {
        if (!pinned?.has(key)) { victim = key; break; }
      }
      if (victim === undefined) return; // everything left is still being drawn
      cache.delete(victim);
    }
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
    this.pinnedTier = -1;
    this.pinnedIndices.clear();
  }
}
