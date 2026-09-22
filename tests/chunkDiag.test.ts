import { describe, it, expect } from 'vitest';
import { ChunkDiagLog, ChunkHeader, fingerprint, headerProblems } from '../utils/chunkDiag';

const header = (over: Partial<ChunkHeader> = {}): ChunkHeader => ({
  chunkIndex: 3,
  chunkDuration: 10,
  expectedFreqBins: 4,
  startSec: 30,
  nCols: 2,
  nFreqBins: 4,
  actualDurationSec: 10,
  dataLength: 8,
  ...over,
});

describe('fingerprint', () => {
  it('is equal for equal data and differs for different data', () => {
    expect(fingerprint(new Uint16Array([1, 2, 3]))).toBe(fingerprint(new Uint16Array([1, 2, 3])));
    expect(fingerprint(new Uint16Array([1, 2, 3]))).not.toBe(fingerprint(new Uint16Array([3, 2, 1])));
  });
});

describe('headerProblems', () => {
  it('accepts a chunk that matches its slot', () => {
    expect(headerProblems(header())).toEqual([]);
  });

  it('flags a start time from another slot', () => {
    expect(headerProblems(header({ startSec: 40 }))[0]).toMatch(/startSec/);
  });

  it('flags a bin count or data length mismatch', () => {
    expect(headerProblems(header({ nFreqBins: 8, dataLength: 16 }))).toHaveLength(1);
    expect(headerProblems(header({ dataLength: 7 }))[0]).toMatch(/data length/);
  });
});

describe('ChunkDiagLog', () => {
  it('flags identical data at a different index on the same tier only', () => {
    const log = new ChunkDiagLog();
    const data = new Uint16Array([5, 6, 7, 8, 1, 2, 3, 4]);
    expect(log.record(1, {}, data, header({ chunkIndex: 3, startSec: 30 })).warnings).toEqual([]);
    // Same tier, other slot: a copy.
    const dup = log.record(1, {}, data, header({ chunkIndex: 4, startSec: 40 }));
    expect(dup.warnings[0]).toMatch(/identical to chunk\(s\) 3/);
    expect(dup.rec.suspect).toBe(true);
    // Refetching the same slot, or the same data on another tier, is fine.
    expect(log.record(1, {}, data, header({ chunkIndex: 3, startSec: 30 })).warnings).toHaveLength(1); // still collides with 4
    expect(log.record(2, {}, data, header({ chunkIndex: 9, startSec: 90 })).warnings).toEqual([]);
  });

  it('does not treat all-zero chunks as copies', () => {
    const log = new ChunkDiagLog();
    const zeros = new Uint16Array(8);
    log.record(0, {}, zeros, header({ chunkIndex: 3, startSec: 30 }));
    expect(log.record(0, {}, zeros, header({ chunkIndex: 4, startSec: 40 })).warnings).toEqual([]);
  });

  it('looks records up by chunk object', () => {
    const log = new ChunkDiagLog();
    const chunk = {};
    log.record(0, chunk, new Uint16Array(8).fill(1), header());
    expect(log.lookup(chunk)?.chunkIndex).toBe(3);
    expect(log.lookup({})).toBeUndefined();
  });
});
