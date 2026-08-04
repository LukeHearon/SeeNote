import { describe, it, expect } from 'vitest';
import { deinterleave, deinterleaveInto } from '../utils/pcm';

describe('deinterleave', () => {
  it('splits stereo into planar channels', () => {
    const src = new Float32Array([1, -1, 2, -2, 3, -3]);
    const [left, right] = deinterleave(src, 3, 2);
    expect(Array.from(left)).toEqual([1, 2, 3]);
    expect(Array.from(right)).toEqual([-1, -2, -3]);
  });

  it('passes mono through unchanged', () => {
    const src = new Float32Array([0.25, 0.5, 0.75]);
    const [mono] = deinterleave(src, 3, 1);
    expect(Array.from(mono)).toEqual([0.25, 0.5, 0.75]);
  });

  it('handles more than two channels', () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6]);
    const chans = deinterleave(src, 2, 3);
    expect(chans.map(c => Array.from(c))).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it('reads only `frames` frames, ignoring a longer buffer', () => {
    const src = new Float32Array([1, -1, 2, -2, 9, -9]);
    const [left, right] = deinterleave(src, 2, 2);
    expect(Array.from(left)).toEqual([1, 2]);
    expect(Array.from(right)).toEqual([-1, -2]);
  });
});

describe('deinterleaveInto', () => {
  it('appends at destOffset so consecutive chunks concatenate', () => {
    const dest = [new Float32Array(4), new Float32Array(4)];
    deinterleaveInto(new Float32Array([1, -1, 2, -2]), 2, dest, 0);
    deinterleaveInto(new Float32Array([3, -3, 4, -4]), 2, dest, 2);
    expect(Array.from(dest[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(dest[1])).toEqual([-1, -2, -3, -4]);
  });

  it('appends at destOffset for mono too', () => {
    const dest = [new Float32Array(4)];
    deinterleaveInto(new Float32Array([1, 2]), 2, dest, 0);
    deinterleaveInto(new Float32Array([3, 4]), 2, dest, 2);
    expect(Array.from(dest[0])).toEqual([1, 2, 3, 4]);
  });
});
