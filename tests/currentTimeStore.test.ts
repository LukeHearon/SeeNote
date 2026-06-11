import { describe, it, expect, vi } from 'vitest';
import { createCurrentTimeStore } from '../utils/currentTimeStore';

describe('createCurrentTimeStore', () => {
  it('starts at 0', () => {
    expect(createCurrentTimeStore().get()).toBe(0);
  });

  it('updates the value on set and notifies subscribers', () => {
    const store = createCurrentTimeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(1.5);
    expect(store.get()).toBe(1.5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('skips notification when the value is unchanged (equality-skip)', () => {
    const store = createCurrentTimeStore();
    store.set(2);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(2);
    expect(listener).not.toHaveBeenCalled();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createCurrentTimeStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.set(1);
    unsub();
    store.set(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
