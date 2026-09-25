import { describe, it, expect } from 'vitest';
import { mergeStops, prevStop, nextStop } from '../utils/jumpStops';

describe('jumpStops', () => {
  const stops = mergeStops([5, 20], [10, 30]);

  it('merges and sorts', () => {
    expect(stops).toEqual([5, 10, 20, 30]);
  });

  it('prev: nearest earlier stop, falling back to 0', () => {
    expect(prevStop(stops, 12)).toBe(10);
    expect(prevStop(stops, 10.01)).toBe(5); // already on 10
    expect(prevStop(stops, 4)).toBe(0);
  });

  it('next: nearest later stop, falling back to end', () => {
    expect(nextStop(stops, 12, 40)).toBe(20);
    expect(nextStop(stops, 19.99, 40)).toBe(30); // already on 20
    expect(nextStop(stops, 31, 40)).toBe(40);
  });
});
