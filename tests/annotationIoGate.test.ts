import { describe, it, expect, vi } from 'vitest';
import { AnnotationIoGate } from '../utils/annotationIoGate';

describe('AnnotationIoGate', () => {
  it('settles immediately when idle', async () => {
    await new AnnotationIoGate().settle();
  });

  it('waits for every operation, including ones begun while waiting', async () => {
    const g = new AnnotationIoGate();
    const end1 = g.begin();
    let settled = false;
    const p = g.settle().then(() => { settled = true; });
    const end2 = g.begin();
    end1();
    await Promise.resolve();
    expect(settled).toBe(false);
    end2();
    await p;
    expect(settled).toBe(true);
  });

  it('end is idempotent', () => {
    const g = new AnnotationIoGate();
    const end = g.begin();
    g.begin();
    end(); end();
    expect(g.busy).toBe(true);
  });

  it('a requested reload keeps the gate busy until claimed', () => {
    const g = new AnnotationIoGate();
    g.requestReload();
    expect(g.busy).toBe(true);
    const own = g.begin();
    g.claimReloads();
    expect(g.busy).toBe(true);
    own();
    expect(g.busy).toBe(false);
  });

  it('an unclaimed reload request expires', () => {
    vi.useFakeTimers();
    const g = new AnnotationIoGate();
    g.requestReload(1000);
    vi.advanceTimersByTime(1001);
    expect(g.busy).toBe(false);
    vi.useRealTimers();
  });
});
