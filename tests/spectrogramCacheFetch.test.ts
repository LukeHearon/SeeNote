import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/tauriCommands', () => ({
  getSpectrogramChunkRange: vi.fn(),
}));

import { getSpectrogramChunkRange } from '../utils/tauriCommands';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';

const fetchMock = vi.mocked(getSpectrogramChunkRange);

const makeCache = () =>
  new MultiTierSpectrogramCache('/nonexistent/test.wav', 1024, 48000, 3600, () => {});

// Let the rejected/resolved promise chains (.catch/.finally) run.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  fetchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('failed chunk fetches', () => {
  it('is not re-requested on every prefetch', async () => {
    fetchMock.mockRejectedValue(new Error('decode failed'));
    const cache = makeCache();
    const tier = cache.selectTier(1, 1000).tier;

    cache.prefetchViewport(10, 11, tier);
    await flush();
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      cache.prefetchViewport(10, 11, tier);
      await flush();
    }
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('is retried after the backoff, and given up on after the attempt limit', async () => {
    fetchMock.mockRejectedValue(new Error('decode failed'));
    const cache = makeCache();
    const tier = cache.selectTier(1, 1000).tier;

    cache.prefetchViewport(10, 11, tier);
    await flush();
    const first = fetchMock.mock.calls.length;

    vi.setSystemTime(MultiTierSpectrogramCache.RETRY_BASE_MS + 1);
    cache.prefetchViewport(10, 11, tier);
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);

    // Burn through the remaining attempts, always waiting out the backoff.
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.now() + 1_000_000);
      cache.prefetchViewport(10, 11, tier);
      await flush();
    }
    const settled = fetchMock.mock.calls.length;
    vi.setSystemTime(Date.now() + 1_000_000);
    cache.prefetchViewport(10, 11, tier);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(settled);
  });

  it('invalidate() forgets failures', async () => {
    fetchMock.mockRejectedValue(new Error('decode failed'));
    const cache = makeCache();
    const tier = cache.selectTier(1, 1000).tier;
    cache.prefetchViewport(10, 11, tier);
    await flush();
    const first = fetchMock.mock.calls.length;

    cache.invalidate();
    cache.prefetchViewport(10, 11, tier);
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
  });
});

describe('invalidate() with requests in flight', () => {
  it('does not let a stale request drive the active count negative', async () => {
    const finishers: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<void>(resolve => { finishers.push(resolve); }));
    const cache = makeCache();
    const tier = cache.selectTier(1, 1000).tier;

    cache.prefetchViewport(10, 10.5, tier);
    expect((cache as unknown as { activeRequests: number }).activeRequests).toBeGreaterThan(0);

    cache.invalidate();
    expect((cache as unknown as { activeRequests: number }).activeRequests).toBe(0);

    finishers.forEach(f => f());
    await flush();
    expect((cache as unknown as { activeRequests: number }).activeRequests).toBe(0);
  });
});

describe('prefetch early-out', () => {
  it('does not rebuild the queue for an unchanged viewport', async () => {
    fetchMock.mockImplementation(() => new Promise<void>(() => {}));
    const cache = makeCache();
    const tier = cache.selectTier(1, 1000).tier;

    cache.prefetchViewport(10, 11, tier);
    const queue = (cache as unknown as { fetchQueue: unknown[] }).fetchQueue;
    cache.prefetchViewport(10, 11, tier);
    expect((cache as unknown as { fetchQueue: unknown[] }).fetchQueue).toBe(queue);
  });

  it('subscribers are told when a chunk arrives', async () => {
    fetchMock.mockImplementation(async (_p, first, _n, _cd, _fft, _hop, onChunk) => {
      onChunk({
        chunk_index: first,
        data: new Uint16Array(4),
        n_cols: 2,
        n_freq_bins: 2,
        start_sec: 0,
        actual_duration_sec: 1,
        sample_rate: 48000,
      } as never);
    });
    const cache = makeCache();
    const listener = vi.fn();
    cache.subscribe(listener);
    const before = cache.version;
    cache.prefetchViewport(0, 0.1, cache.selectTier(1, 1000).tier);
    await flush();
    expect(listener).toHaveBeenCalled();
    expect(cache.version).toBeGreaterThan(before);
  });
});
