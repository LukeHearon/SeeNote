import { describe, it, expect } from 'vitest';
import { manifestThresholds, prefillThresholds } from '../utils/buzzdetectManifest';

describe('manifestThresholds', () => {
  const manifest = JSON.stringify({
    modelname: 'model_general_v3',
    framelength_s: 0.96,
    thresholds: { ins_buzz: -1.2, frog: 0.4 },
  });

  it('keys by bare class name when the prefix is trimmed', () => {
    expect(manifestThresholds(manifest, true)).toEqual({ ins_buzz: -1.2, frog: 0.4 });
  });

  it('keys by the full column name when the prefix is kept', () => {
    expect(manifestThresholds(manifest, false)).toEqual({ activation_ins_buzz: -1.2, activation_frog: 0.4 });
  });

  it('reads nothing from a manifest without thresholds, or from bad JSON', () => {
    expect(manifestThresholds(JSON.stringify({ modelname: 'm' }), true)).toEqual({});
    expect(manifestThresholds('{ nope', true)).toEqual({});
    expect(manifestThresholds('null', true)).toEqual({});
  });

  it('skips a non-numeric value', () => {
    expect(manifestThresholds(JSON.stringify({ thresholds: { a: 'high', b: 1 } }), true)).toEqual({ b: 1 });
  });
});

describe('prefillThresholds', () => {
  it('fills only neurons with no entry, leaving set and cleared ones alone', () => {
    const { thresholds, filled } = prefillThresholds(
      { ins_buzz: -2, frog: null },
      { ins_buzz: -1.2, frog: 0.4, human: 0.1 },
    );
    expect(thresholds).toEqual({ ins_buzz: -2, frog: null, human: 0.1 });
    expect(filled).toEqual(['human']);
  });

  it('returns the same object when there is nothing to fill', () => {
    const current = { ins_buzz: -2 };
    expect(prefillThresholds(current, { ins_buzz: -1.2 }).thresholds).toBe(current);
  });
});
