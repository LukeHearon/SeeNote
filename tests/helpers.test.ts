import { describe, it, expect } from 'vitest';
import {
  formatTime,
  makeAnnotationFromTool,
  calculateAnnotationLayers,
  generateAudacityContent,
  parseAudacityContent,
  mergeAnnotations,
  stripExt,
  shuffleArray,
  clamp,
  updateAnnotation,
} from '../utils/helpers';
import { getExt } from '../constants';
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
  const tool: AnnotationTool = { id: 't1', key: '1', text: 'Bee', color: '#ff8800' };
  const customTool: AnnotationTool = { id: 'custom', key: '0', text: 'IGNORED_FOR_CUSTOM', color: '#00ff00' };

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
    const unassigned: AnnotationTool = { id: 'tx', key: null, text: 'x', color: '#000' };
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

describe('getExt', () => {
  it('returns the lowercased extension without the dot', () => {
    expect(getExt('foo.MP3')).toBe('mp3');
    expect(getExt('/a/b/bird.WAV')).toBe('wav');
  });

  it('returns the trailing segment for dotless paths (current behavior)', () => {
    // split('.').pop() on a dotless string returns the whole string.
    expect(getExt('noext')).toBe('noext');
  });

  it('uses the last dot for multi-dot names', () => {
    expect(getExt('archive.tar.gz')).toBe('gz');
  });
});

describe('stripExt', () => {
  it('removes a trailing extension', () => {
    expect(stripExt('bird.mp3')).toBe('bird');
    expect(stripExt('/a/b/clip.wav')).toBe('/a/b/clip');
  });

  it('strips only the last extension', () => {
    expect(stripExt('archive.tar.gz')).toBe('archive.tar');
  });

  it('leaves a path with no extension unchanged', () => {
    expect(stripExt('noext')).toBe('noext');
    expect(stripExt('/a/b/dir')).toBe('/a/b/dir');
  });

  it('does not strip a dot that lives in a directory segment', () => {
    // The final segment has no dot, so nothing is stripped.
    expect(stripExt('/a/b.c/file')).toBe('/a/b.c/file');
  });
});

describe('shuffleArray', () => {
  it('returns a permutation (same length and multiset)', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffleArray(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
  });

  it('does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    shuffleArray(input);
    expect(input).toEqual(snapshot);
  });

  it('returns a new array reference', () => {
    const input = [1, 2, 3];
    expect(shuffleArray(input)).not.toBe(input);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffleArray([])).toEqual([]);
    expect(shuffleArray(['a'])).toEqual(['a']);
  });
});

describe('clamp', () => {
  it('passes values already inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('clamps to the lower and upper bounds', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('works with negative and fractional ranges', () => {
    expect(clamp(-7.5, -5, 5)).toBe(-5);
    expect(clamp(1.25, -5, 5)).toBe(1.25);
  });
});

describe('updateAnnotation', () => {
  it('replaces only the matching annotation, leaving others by reference', () => {
    const a = ann(0, 1, 'a', { id: 'a' });
    const b = ann(2, 3, 'b', { id: 'b' });
    const out = updateAnnotation([a, b], 'b', x => ({ ...x, text: 'B' }));
    expect(out[0]).toBe(a); // untouched item keeps its reference
    expect(out[1]).not.toBe(b);
    expect(out[1].text).toBe('B');
  });

  it('returns a new array and never mutates the input', () => {
    const a = ann(0, 1, 'a', { id: 'a' });
    const input = [a];
    const out = updateAnnotation(input, 'a', x => ({ ...x, start: 5 }));
    expect(out).not.toBe(input);
    expect(input[0].start).toBe(0);
    expect(out[0].start).toBe(5);
  });

  it('is a no-op (content-wise) when no id matches, including null', () => {
    const a = ann(0, 1, 'a', { id: 'a' });
    expect(updateAnnotation([a], 'missing', x => ({ ...x, text: 'X' }))).toEqual([a]);
    expect(updateAnnotation([a], null, x => ({ ...x, text: 'X' }))).toEqual([a]);
  });
});

describe('parseAudacityContent', () => {
  const tools: AnnotationTool[] = [
    { id: 't1', key: '1', text: 'bird', color: '#ff0000' },
    { id: 't2', key: '2', text: 'noise', color: '#00ff00' },
  ];

  it('parses tab-delimited rows and matches tools by text', () => {
    const content = '0.5\t1.5\tbird\n2.0\t3.0\tnoise\n';
    const result = parseAudacityContent(content, tools);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 0.5, end: 1.5, text: 'bird', toolKey: '1', color: '#ff0000' });
    expect(result[1]).toMatchObject({ start: 2.0, end: 3.0, text: 'noise', toolKey: '2', color: '#00ff00' });
  });

  it('falls back to Custom tool (key 0) and white for unmatched text', () => {
    const result = parseAudacityContent('1\t2\tunknown\n', tools);
    expect(result[0]).toMatchObject({ toolKey: '0', color: '#ffffff', text: 'unknown' });
  });

  it('preserves tabs inside the label text', () => {
    const result = parseAudacityContent('1\t2\ta\tb\n', tools);
    expect(result[0].text).toBe('a\tb');
  });

  it('skips malformed rows (too few columns or non-numeric times)', () => {
    const result = parseAudacityContent('bad\nrow\tonly\nx\ty\tlabel\n0\t1\tbird\n', tools);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('bird');
  });

  it('returns empty array for empty content', () => {
    expect(parseAudacityContent('', tools)).toEqual([]);
  });

  it('round-trips through generateAudacityContent', () => {
    const original = [ann(0.25, 1.75, 'bird', { toolKey: '1', color: '#ff0000' })];
    const text = generateAudacityContent(original);
    const parsed = parseAudacityContent(text, tools);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ start: 0.25, end: 1.75, text: 'bird', toolKey: '1' });
  });
});

describe('mergeAnnotations', () => {
  it('appends incoming onto existing, sorted by start', () => {
    const existing = [ann(2, 3, 'a', { id: 'e1' })];
    const incoming = [ann(0, 1, 'b', { id: 'i1' }), ann(5, 6, 'c', { id: 'i2' })];
    const merged = mergeAnnotations(existing, incoming);
    expect(merged.map(a => a.text)).toEqual(['b', 'a', 'c']);
  });

  it('gives incoming annotations fresh ids to avoid collisions', () => {
    const existing = [ann(0, 1, 'a', { id: 'dup' })];
    const incoming = [ann(2, 3, 'b', { id: 'dup' })];
    const merged = mergeAnnotations(existing, incoming);
    const ids = merged.map(a => a.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('dup'); // existing id is preserved
  });

  it('does not mutate its inputs', () => {
    const existing = [ann(0, 1, 'a', { id: 'e1' })];
    const incoming = [ann(2, 3, 'b', { id: 'i1' })];
    const existingCopy = [...existing];
    const incomingCopy = [...incoming];
    mergeAnnotations(existing, incoming);
    expect(existing).toEqual(existingCopy);
    expect(incoming).toEqual(incomingCopy);
  });
});
