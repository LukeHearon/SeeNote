/**
 * PcmCache — LRU cache of decoded PCM ranges for instant selection replay.
 *
 * On a cache hit, AudioEngine.play() bypasses all Rust IPC and schedules
 * directly from the stored Float32Arrays. Keyed on integer frame indices
 * (filePath:startFrame:endFrame). Owns the `preloadId` generation token so a
 * superseded preload loop exits; this is distinct from AudioEngine's `playId`.
 */

import { startPcmStream, readPcmChunk, closePcmStream } from './tauriCommands';
import { clamp } from './helpers';

/** Cached decoded PCM for a range, keyed by (filePath, startSec, endSec). */
export interface PcmCacheEntry {
  /** Deinterleaved channel data — index by channel, then frame. */
  channels: Float32Array[];
  totalFrames: number;
  startSec: number;
  endSec: number;
}

/** A subrange of a cache entry — what to actually play on a cache hit. */
export interface PcmCacheSlice {
  entry: PcmCacheEntry;
  /** First frame to play, as an offset into the entry's channels. */
  startFrame: number;
  frameCount: number;
  /** Media time of the first frame (what we tell the playhead). */
  startSec: number;
  endSec: number;
}

/** How many frames to fetch per IPC call (~1 second of audio). */
const CHUNK_DURATION_SEC = 1.0;
/** Maximum number of preloaded regions to keep in the PCM replay cache. */
const MAX_PCM_CACHE_ENTRIES = 8;

export class PcmCache {
  // Decoded PCM for preloaded regions. Keyed by "filePath:startFrame:endFrame".
  private _pcmCache = new Map<string, PcmCacheEntry>();
  private _pcmCacheOrder: string[] = [];  // front = LRU (oldest)
  /** Incremented on every preloadRange()/clear()/dispose(); stale preload loops exit. */
  private preloadId = 0;

  private _log: (msg: string, type?: 'info' | 'error') => void;

  constructor(log: (msg: string, type?: 'info' | 'error') => void) {
    this._log = log;
  }

  /** Drop all cached entries and cancel any in-flight preload. */
  clear(): void {
    this._pcmCache.clear();
    this._pcmCacheOrder = [];
    this.preloadId++;
  }

  /** Cancel any in-flight preload without clearing the cache (seek()/dispose()). */
  cancelPreload(): void {
    this.preloadId++;
  }

  private _pcmCacheKey(filePath: string, fileSampleRate: number, start: number, end: number): string {
    // Key on integer frame indices rather than fractional seconds: at 48 kHz,
    // .toFixed(6) only has ~0.048-sample resolution, so adjacent sample-distinct
    // seek targets can collide on the same key (finding 4).
    const sr = fileSampleRate;
    const startFrame = Math.round(start * sr);
    const endFrame = Math.round(end * sr);
    return `${filePath}:${startFrame}:${endFrame}`;
  }

  store(
    filePath: string,
    fileSampleRate: number,
    start: number,
    end: number,
    channels: Float32Array[],
    totalFrames: number,
  ): void {
    const key = this._pcmCacheKey(filePath, fileSampleRate, start, end);
    if (this._pcmCache.has(key)) return;
    while (this._pcmCacheOrder.length >= MAX_PCM_CACHE_ENTRIES) {
      const oldest = this._pcmCacheOrder.shift()!;
      this._pcmCache.delete(oldest);
    }
    this._pcmCache.set(key, { channels, totalFrames, startSec: start, endSec: end });
    this._pcmCacheOrder.push(key);
  }

  /**
   * Find a cached entry whose range *contains* [reqStart, reqEnd] and return the
   * subrange to play. Searches MRU-first so the freshest entry wins when multiple
   * contain the request. Returns null on miss.
   */
  find(fileSampleRate: number, reqStart: number, reqEnd: number): PcmCacheSlice | null {
    if (reqEnd <= reqStart) return null;
    const EPS = 1e-6;
    const sr = fileSampleRate;
    for (let i = this._pcmCacheOrder.length - 1; i >= 0; i--) {
      const key = this._pcmCacheOrder[i];
      const entry = this._pcmCache.get(key);
      if (!entry) continue;
      if (entry.startSec - EPS <= reqStart && entry.endSec + EPS >= reqEnd) {
        const startFrame = Math.max(0, Math.round((reqStart - entry.startSec) * sr));
        const endFrame = Math.min(entry.totalFrames, Math.round((reqEnd - entry.startSec) * sr));
        const frameCount = endFrame - startFrame;
        if (frameCount <= 0) continue;
        // Promote to MRU
        this._pcmCacheOrder.splice(i, 1);
        this._pcmCacheOrder.push(key);
        return { entry, startFrame, frameCount, startSec: reqStart, endSec: reqEnd };
      }
    }
    return null;
  }

  /**
   * Pre-decode and cache the PCM for [startSec, endSec] so subsequent plays in
   * that range start instantaneously. Safe to call repeatedly — if the range is
   * already covered by a cached entry, returns without decoding. Rapid calls
   * supersede each other via `preloadId`, so only the latest request completes.
   */
  async preloadRange(
    filePath: string,
    fileChannels: number,
    fileSampleRate: number,
    startSec: number,
    endSec: number,
  ): Promise<void> {
    if (endSec <= startSec) return;
    if (this.find(fileSampleRate, startSec, endSec)) return;

    const myPreloadId = ++this.preloadId;
    const path = filePath;
    const ch = fileChannels;
    const sr = fileSampleRate;
    const chunkFrames = Math.floor(CHUNK_DURATION_SEC * sr);

    let handle;
    try {
      handle = await startPcmStream(path, startSec);
    } catch (err) {
      this._log(`preload startPcmStream failed: ${String(err)}`, 'error');
      return;
    }
    if (this.preloadId !== myPreloadId) {
      closePcmStream(handle.stream_id).catch(() => {});
      return;
    }

    const cacheChunks: Array<{ samples: number[]; frames: number }> = [];
    let cacheTotalFrames = 0;
    let reachedEnd = false;

    while (this.preloadId === myPreloadId) {
      let chunk;
      try {
        chunk = await readPcmChunk(handle.stream_id, chunkFrames);
      } catch (err) {
        this._log(`preload readPcmChunk failed: ${String(err)}`, 'error');
        closePcmStream(handle.stream_id).catch(() => {});
        return;
      }
      if (this.preloadId !== myPreloadId) break;
      if (chunk.frames_read === 0) { reachedEnd = true; break; }

      const chunkMediaStart = chunk.start_frame / sr;
      const chunkDurationSec = chunk.frames_read / sr;
      const chunkMediaEnd = chunkMediaStart + chunkDurationSec;

      let framesToCache = chunk.frames_read;
      if (chunkMediaEnd >= endSec) {
        framesToCache = clamp(Math.round((endSec - chunkMediaStart) * sr), 0, chunk.frames_read);
        reachedEnd = true;
      }

      if (framesToCache > 0) {
        cacheChunks.push({ samples: chunk.samples.slice(0, framesToCache * ch), frames: framesToCache });
        cacheTotalFrames += framesToCache;
      }

      if (reachedEnd) break;
    }

    closePcmStream(handle.stream_id).catch(() => {});
    if (this.preloadId !== myPreloadId) return;

    if (reachedEnd && cacheChunks.length > 0) {
      const channels: Float32Array[] = Array.from({ length: ch }, () => new Float32Array(cacheTotalFrames));
      let frameOffset = 0;
      for (const { samples, frames } of cacheChunks) {
        for (let c = 0; c < ch; c++) {
          const dest = channels[c];
          for (let i = 0; i < frames; i++) {
            dest[frameOffset + i] = samples[i * ch + c];
          }
        }
        frameOffset += frames;
      }
      this.store(filePath, fileSampleRate, startSec, endSec, channels, cacheTotalFrames);
      this._log(`preloaded ${startSec.toFixed(3)}s–${endSec.toFixed(3)}s (${cacheTotalFrames} frames)`);
    }
  }
}
