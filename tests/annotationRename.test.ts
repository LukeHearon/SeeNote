import { describe, it, expect } from 'vitest';
import { streamSearch } from '../utils/annotationRename';

describe('streamSearch', () => {
  it('reports results in item order regardless of resolution timing', async () => {
    const items = ['a', 'b', 'c', 'd'];
    // Reverse-order resolution delays: 'a' resolves last, 'd' first.
    const delays: Record<string, number> = { a: 30, b: 20, c: 10, d: 0 };
    const searchOne = (item: string) => new Promise<string>(resolve => {
      setTimeout(() => resolve(`found:${item}`), delays[item]);
    });
    const found: string[] = [];
    await streamSearch(items, searchOne, (r) => found.push(r));
    expect(found).toEqual(['found:a', 'found:b', 'found:c', 'found:d']);
  });

  it('skips items whose search resolves to null', async () => {
    const items = ['a', 'b', 'c'];
    const searchOne = (item: string) => Promise.resolve(item === 'b' ? null : item);
    const found: string[] = [];
    await streamSearch(items, searchOne, (r) => found.push(r));
    expect(found).toEqual(['a', 'c']);
  });

  it('stops issuing further batches once cancelled, discarding an in-flight batch', async () => {
    // Batch size is fixed at 12 internally. Flip `cancelled` partway through
    // the second batch (call #13) to exercise both cancellation checkpoints:
    // the in-flight batch still runs to completion but its results are
    // discarded, and no third batch is ever started.
    const items = Array.from({ length: 30 }, (_, i) => `item${i}`);
    let cancelled = false;
    let calls = 0;
    const searchOne = (item: string) => {
      calls++;
      if (calls === 13) cancelled = true;
      return Promise.resolve(item);
    };
    const found: string[] = [];
    await streamSearch(items, searchOne, (r) => found.push(r), () => cancelled);
    expect(found.length).toBe(12);
    expect(calls).toBe(24);
  });
});
