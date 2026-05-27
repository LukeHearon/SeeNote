import { describe, it, expect } from 'vitest';
import {
  formatTime,
  makeAnnotationFromTool,
  calculateAnnotationLayers,
  generateCSVContent,
  generateAudacityContent,
  generateJSONContent,
} from '../utils/helpers';
import { Annotation, AnnotationTool } from '../types';

// Helper to build an annotation without repeating boilerplate.
const ann = (
  start: number,
  end: number,
  text = 'label',
  extras: Partial<Annotation> = {},
): Annotation => ({
  id: extras.id ?? 'id-' + start + '-' + end,
  toolKey: extras.toolKey ?? '1',
  start,
  end,
  text,
  color: extras.color,
});

describe('formatTime', () => {
  it('formats zero as 0.00s', () => {
    expect(formatTime(0)).toBe('0.00s');
  });

  it('formats sub-second values with two-digit centiseconds', () => {
    expect(formatTime(0.5)).toBe('0.50s');
    expect(formatTime(0.07)).toBe('0.07s');
    // Floor on centiseconds — 0.999s rounds DOWN to 99 cs.
    expect(formatTime(0.999)).toBe('0.99s');
  });

  it('switches to minutes once seconds >= 60', () => {
    expect(formatTime(60)).toBe('1m0.00s');
    expect(formatTime(61.25)).toBe('1m1.25s');
    expect(formatTime(125)).toBe('2m5.00s');
  });

  it('switches to hours once seconds >= 3600', () => {
    expect(formatTime(3600)).toBe('1h0m0.00s');
    expect(formatTime(3661.5)).toBe('1h1m1.50s');
    expect(formatTime(7325.123)).toBe('2h2m5.12s');
  });

  it('handles large values without scientific notation', () => {
    // 10 hours, 0 min, 0 s
    expect(formatTime(36000)).toBe('10h0m0.00s');
  });

  it('negative input: documents current behavior (Math.floor on negatives floors toward -inf)', () => {
    // -0.5s -> h=-1, m=59, s=59, cs=... This documents the (un)expected output.
    // We do not assert a specific string — just that it returns a string and
    // does not throw. formatTime is not designed for negative input.
    const out = formatTime(-0.5);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('makeAnnotationFromTool', () => {
  const tool: AnnotationTool = { key: '1', text: 'Bee', color: '#ff8800' };
  const customTool: AnnotationTool = { key: '0', text: 'IGNORED_FOR_CUSTOM', color: '#00ff00' };

  it('produces a non-empty string id', () => {
    const a = makeAnnotationFromTool(tool, 1.0, 2.0);
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
  });

  it('preserves start and end exactly', () => {
    const a = makeAnnotationFromTool(tool, 1.2345678, 9.8765432);
    expect(a.start).toBe(1.2345678);
    expect(a.end).toBe(9.8765432);
  });

  it("uses tool.text for non-custom tools", () => {
    const a = makeAnnotationFromTool(tool, 0, 1);
    expect(a.text).toBe('Bee');
    expect(a.toolKey).toBe('1');
    expect(a.color).toBe('#ff8800');
  });

  it("forces empty text for the custom tool (key '0'), regardless of tool.text", () => {
    const a = makeAnnotationFromTool(customTool, 0, 1);
    expect(a.text).toBe('');
    expect(a.toolKey).toBe('0');
    expect(a.color).toBe('#00ff00');
  });

  it('throws when the tool key is null (unassigned)', () => {
    const unassigned: AnnotationTool = { key: null, text: 'x', color: '#000' };
    expect(() => makeAnnotationFromTool(unassigned, 0, 1)).toThrow();
  });
});

describe('calculateAnnotationLayers', () => {
  it('returns [] for empty input', () => {
    expect(calculateAnnotationLayers([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [ann(2, 3), ann(0, 1)];
    const snapshot = input.map(a => ({ ...a }));
    calculateAnnotationLayers(input);
    expect(input).toEqual(snapshot);
  });

  it('assigns layer 0 to a single annotation', () => {
    const out = calculateAnnotationLayers([ann(0, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].layerIndex).toBe(0);
  });

  it('places two non-overlapping annotations both on layer 0', () => {
    const out = calculateAnnotationLayers([ann(0, 1), ann(2, 3)]);
    expect(out.map(a => a.layerIndex)).toEqual([0, 0]);
  });

  it('places two overlapping annotations on layers 0 and 1', () => {
    const out = calculateAnnotationLayers([ann(0, 2), ann(1, 3)]);
    expect(out.map(a => a.layerIndex)).toEqual([0, 1]);
  });

  it('places three mutually overlapping annotations on layers 0, 1, 2', () => {
    const out = calculateAnnotationLayers([ann(0, 3), ann(1, 4), ann(2, 5)]);
    expect(out.map(a => a.layerIndex)).toEqual([0, 1, 2]);
  });

  it('reuses layer 0 once the first annotation has ended (chain)', () => {
    // 0..1, then 0.5..2 (overlap with first -> layer 1), then 1.5..3 (overlap with second but
    // not first -> layer 0 reused).
    const out = calculateAnnotationLayers([ann(0, 1), ann(0.5, 2), ann(1.5, 3)]);
    const byStart = [...out].sort((a, b) => a.start - b.start);
    expect(byStart[0].layerIndex).toBe(0); // 0..1
    expect(byStart[1].layerIndex).toBe(1); // 0.5..2
    expect(byStart[2].layerIndex).toBe(0); // 1.5..3 reuses layer 0
  });

  it('sorts output by start time', () => {
    const out = calculateAnnotationLayers([ann(5, 6), ann(0, 1), ann(2, 3)]);
    expect(out.map(a => a.start)).toEqual([0, 2, 5]);
  });

  it('handles annotations with identical start times by stacking them on new layers', () => {
    const out = calculateAnnotationLayers([ann(0, 1), ann(0, 2), ann(0, 3)]);
    // All three start at the same instant — none of the layer ends are <= 0
    // before placement, so each goes onto a fresh layer.
    const layers = out.map(a => a.layerIndex).sort();
    expect(layers).toEqual([0, 1, 2]);
  });

  it('treats touching boundaries (prev.end === next.start) as non-overlapping (reuses layer)', () => {
    // findIndex uses end <= start, so a layer whose end exactly equals the
    // next annotation's start is considered free.
    const out = calculateAnnotationLayers([ann(0, 1), ann(1, 2)]);
    expect(out.map(a => a.layerIndex)).toEqual([0, 0]);
  });
});

describe('generateCSVContent', () => {
  it('emits the header even with no annotations', () => {
    const csv = generateCSVContent([]);
    expect(csv).toBe('Label,Start,End\n');
  });

  it('starts with the canonical header', () => {
    const csv = generateCSVContent([ann(0, 1, 'a')]);
    expect(csv.startsWith('Label,Start,End\n')).toBe(true);
  });

  it('quotes the label and escapes embedded quotes by doubling them', () => {
    const csv = generateCSVContent([ann(0, 1, 'has "quote" and, comma')]);
    expect(csv).toContain('"has ""quote"" and, comma"');
  });

  it('passes decimals through to start/end (7-decimal default = sample-accurate at 192 kHz)', () => {
    const csv = generateCSVContent([ann(1.23456789, 2.0, 'x')]);
    // Default 7 decimals: rounds 1.23456789 -> 1.2345679 (printed with trailing zeros as needed).
    expect(csv).toContain(',1.2345679,2.0000000\n');
  });

  it('respects a custom decimals argument', () => {
    const csv = generateCSVContent([ann(1.23456789, 2.5, 'x')], 3);
    expect(csv).toContain(',1.235,2.500\n');
  });

  it('rounds the classic 0.1 + 0.2 case cleanly at default precision', () => {
    const csv = generateCSVContent([ann(0.1 + 0.2, 1, 'x')]);
    // 0.30000000000000004 -> rounded to 0.3000000
    expect(csv).toContain(',0.3000000,1.0000000\n');
  });
});

describe('generateAudacityContent', () => {
  it('produces an empty string for an empty list', () => {
    expect(generateAudacityContent([])).toBe('');
  });

  it('emits start<TAB>end<TAB>text<NEWLINE> per annotation', () => {
    const out = generateAudacityContent([ann(0, 1, 'hello')]);
    expect(out).toBe('0.0000000\t1.0000000\thello\n');
  });

  it('does NOT escape commas or quotes in the label (Audacity format is tab-delimited)', () => {
    const out = generateAudacityContent([ann(0, 1, 'a,b "c"')], 3);
    expect(out).toBe('0.000\t1.000\ta,b "c"\n');
  });

  it('respects decimals argument', () => {
    const out = generateAudacityContent([ann(1.23456789, 2, 'x')], 4);
    expect(out).toBe('1.2346\t2.0000\tx\n');
  });
});

describe('generateJSONContent', () => {
  it('round-trips through JSON.parse for an empty list', () => {
    const json = generateJSONContent([]);
    expect(JSON.parse(json)).toEqual([]);
  });

  it('round-trips annotation fields through JSON.parse', () => {
    const input = [ann(0.5, 1.5, 'foo', { id: 'abc', toolKey: '2', color: '#fff' })];
    const parsed = JSON.parse(generateJSONContent(input));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 'abc',
      toolKey: '2',
      text: 'foo',
      color: '#fff',
      start: 0.5,
      end: 1.5,
    });
  });

  it('rounds start/end to the configured decimals', () => {
    const input = [ann(1.23456789, 2.987654321, 'x')];
    const parsed = JSON.parse(generateJSONContent(input, 3));
    expect(parsed[0].start).toBe(1.235);
    expect(parsed[0].end).toBe(2.988);
  });

  it('rounds the 0.1 + 0.2 case to a clean value', () => {
    const parsed = JSON.parse(generateJSONContent([ann(0.1 + 0.2, 1, 'x')]));
    expect(parsed[0].start).toBe(0.3);
  });

  it('survives commas, quotes, and newlines in text without breaking JSON', () => {
    const tricky = 'has "quote", comma\nand newline';
    const parsed = JSON.parse(generateJSONContent([ann(0, 1, tricky)]));
    expect(parsed[0].text).toBe(tricky);
  });

  it('produces pretty-printed (indented) JSON', () => {
    const out = generateJSONContent([ann(0, 1, 'a')]);
    expect(out).toContain('\n');
    expect(out).toContain('  '); // two-space indent
  });
});

// Cross-cutting: decimal precision is the cornerstone export contract.
// These assertions document the sample-accuracy guarantee at the boundary
// between in-memory floats and serialized output.
describe('export decimal precision (cross-cutting)', () => {
  it('all three generators agree on rounding behavior for the same input', () => {
    const a = ann(1.2345678901, 2.3456789012, 'x');
    const csv = generateCSVContent([a], 7);
    const aud = generateAudacityContent([a], 7);
    const json = generateJSONContent([a], 7);
    // Both text formats print 1.2345679 / 2.3456789
    expect(csv).toContain('1.2345679');
    expect(csv).toContain('2.3456789');
    expect(aud).toContain('1.2345679');
    expect(aud).toContain('2.3456789');
    const parsed = JSON.parse(json);
    expect(parsed[0].start).toBe(1.2345679);
    expect(parsed[0].end).toBe(2.3456789);
  });

  it('handles decimals=0 (integer rounding)', () => {
    const csv = generateCSVContent([ann(1.7, 2.4, 'x')], 0);
    expect(csv).toContain(',2,2\n');
  });
});
