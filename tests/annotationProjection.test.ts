import { describe, it, expect } from 'vitest';
import { Annotation } from '../types';
import { projectAnnotations, reconcileAnnotations } from '../utils/annotationProjection';
import { buildSubsetTimeline, identityTimeline } from '../utils/subsetTimeline';

// Kept: source 10–12 (display 0–2) and 50–53 (display 2–5).
const tl = buildSubsetTimeline([{ start: 10, end: 12 }, { start: 50, end: 53 }], 100);

const ann = (id: string, start: number, end: number, text = id): Annotation =>
  ({ id, start, end, text });

describe('projectAnnotations', () => {
  it('passes everything through on the identity timeline', () => {
    const list = [ann('a', 1, 2)];
    const r = projectAnnotations(list, identityTimeline(100));
    expect(r.shown).toBe(list);
    expect(r.hidden).toEqual([]);
  });

  it('moves shown annotations onto the display axis', () => {
    const r = projectAnnotations([ann('a', 10.5, 11.5), ann('b', 50, 51)], tl);
    expect(r.shown.map(a => [a.id, a.start, a.end])).toEqual([
      ['a', 0.5, 1.5],
      ['b', 2, 3],
    ]);
    expect(r.hidden).toEqual([]);
  });

  it('holds back annotations that live in hidden time', () => {
    const r = projectAnnotations([ann('a', 10.5, 11), ann('gone', 20, 30)], tl);
    expect(r.shown.map(a => a.id)).toEqual(['a']);
    expect(r.hidden.map(a => a.id)).toEqual(['gone']);
  });
});

describe('reconcileAnnotations', () => {
  it('returns the displayed list unchanged on the identity timeline', () => {
    const list = [ann('a', 1, 2)];
    expect(reconcileAnnotations(list, [], [], identityTimeline(100))).toBe(list);
  });

  it('leaves untouched annotations at their exact stored source bounds', () => {
    const source = [ann('a', 10.5, 11.5)];
    const { shown, hidden } = projectAnnotations(source, tl);
    const back = reconcileAnnotations(shown, source, hidden, tl);
    expect(back).toEqual(source);
  });

  it('converts a moved annotation back to source time', () => {
    const source = [ann('a', 10.5, 11.5)];
    const { shown, hidden } = projectAnnotations(source, tl);
    // The user dragged it to display 3–4, which is inside the second span.
    const edited = [{ ...shown[0], start: 3, end: 4 }];
    const back = reconcileAnnotations(edited, source, hidden, tl);
    expect(back).toEqual([ann('a', 51, 52)]);
  });

  it('clamps an edited annotation to the span its start is in', () => {
    const source = [ann('a', 10.5, 11.5)];
    const { shown, hidden } = projectAnnotations(source, tl);
    // Dragged so it would run across the cut at display 2.
    const edited = [{ ...shown[0], start: 1, end: 4 }];
    const back = reconcileAnnotations(edited, source, hidden, tl);
    expect(back).toEqual([ann('a', 11, 12)]);
  });

  it('carries hidden annotations through untouched', () => {
    const source = [ann('a', 10.5, 11.5), ann('gone', 20, 30)];
    const { shown, hidden } = projectAnnotations(source, tl);
    const back = reconcileAnnotations(shown, source, hidden, tl);
    expect(back.map(a => [a.id, a.start, a.end])).toEqual([
      ['a', 10.5, 11.5],
      ['gone', 20, 30],
    ]);
  });

  it('does not read a hidden annotation as a deletion', () => {
    const source = [ann('a', 10.5, 11.5), ann('gone', 20, 30)];
    const { shown, hidden } = projectAnnotations(source, tl);
    // The user deleted the only annotation they could see.
    const back = reconcileAnnotations([], source, hidden, tl);
    expect(back.map(a => a.id)).toEqual(['gone']);
  });

  it('converts a newly created annotation', () => {
    const back = reconcileAnnotations([ann('new', 0.25, 0.75)], [], [], tl);
    expect(back).toEqual([ann('new', 10.25, 10.75)]);
  });

  it('keeps a text-only edit from disturbing the bounds', () => {
    const source = [ann('a', 10.5, 11.5, 'bee')];
    const { shown, hidden } = projectAnnotations(source, tl);
    const edited = [{ ...shown[0], text: 'fly' }];
    const back = reconcileAnnotations(edited, source, hidden, tl);
    expect(back).toEqual([ann('a', 10.5, 11.5, 'fly')]);
  });
});
