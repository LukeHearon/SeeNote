import { getSpectrogramChunk } from './utils/tauriCommands';

export interface CachedChunk {
  data: Uint8Array;
  nCols: number;
  nFreqBins: number;
  startSec: number;
  actualDurationSec: number;
  sampleRate: number;
  lastAccessed: number;
}

export class SpectrogramChunkCache {
  private cache = new Map<number, CachedChunk>();
  private pending = new Set<number>();

  constructor(
    private readonly filePath: string,
    private readonly fftSize: number,
    private readonly hopSize: number,
    private readonly chunkDuration: number = 30,
    private readonly maxChunks: number = 12,
    private readonly onChunkLoaded: () => void = () => {},
  ) {}

  /** Returns the total duration of the file covered by a given number of chunks. */
  private chunkIndexForTime(timeSec: number): number {
    return Math.floor(timeSec / this.chunkDuration);
  }

  /**
   * Returns the cached chunk that covers `timeSec`, or null if not yet loaded.
   * Also marks it as recently accessed.
   */
  getChunkForTime(timeSec: number): CachedChunk | null {
    const idx = this.chunkIndexForTime(timeSec);
    const chunk = this.cache.get(idx);
    if (chunk) {
      chunk.lastAccessed = Date.now();
      return chunk;
    }
    return null;
  }

  /**
   * Requests the chunk covering `centerTime` and adjacent chunks.
   * Non-blocking: fires async fetches and returns immediately.
   */
  prefetchAround(centerTime: number): void {
    const center = this.chunkIndexForTime(centerTime);
    const toFetch = [center - 1, center, center + 1, center + 2].filter(i => i >= 0);
    for (const idx of toFetch) {
      if (!this.cache.has(idx) && !this.pending.has(idx)) {
        this.fetchChunk(idx);
      }
    }
  }

  private async fetchChunk(idx: number): Promise<void> {
    this.pending.add(idx);
    const startSec = idx * this.chunkDuration;

    try {
      const result = await getSpectrogramChunk(
        this.filePath,
        startSec,
        this.chunkDuration,
        this.fftSize,
        this.hopSize,
      );

      const chunk: CachedChunk = {
        data: new Uint8Array(result.data),
        nCols: result.n_cols,
        nFreqBins: result.n_freq_bins,
        startSec: result.start_sec,
        actualDurationSec: result.actual_duration_sec,
        sampleRate: result.sample_rate,
        lastAccessed: Date.now(),
      };

      this.evictLRU();
      this.cache.set(idx, chunk);
      this.onChunkLoaded();
    } catch (err) {
      console.error(`SpectrogramChunkCache: failed to fetch chunk ${idx}:`, err);
    } finally {
      this.pending.delete(idx);
    }
  }

  private evictLRU(): void {
    if (this.cache.size < this.maxChunks) return;
    let oldestTime = Infinity;
    let oldestKey = -1;
    for (const [k, v] of this.cache) {
      if (v.lastAccessed < oldestTime) {
        oldestTime = v.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey >= 0) this.cache.delete(oldestKey);
  }

  /** Clears all cached and in-flight data (call when fftSize/hopSize changes). */
  invalidate(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
