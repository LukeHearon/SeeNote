// Editing several annotations as one: Shift-click multi-select, then drag,
// lengthen, shorten, or retype the duration of the whole set.
//
// Every gesture reduces to a single shared delta applied to each member, so the
// set keeps its internal shape. The delta is clamped against ALL members at once
// — if one hits the end of its span the whole set stops, rather than the others
// carrying on and the set distorting. A lone annotation is the one-member case
// of the same code, so the single and multi paths cannot drift apart.
//
// All times are in whatever axis the caller works in (display time in the
// pointer hook); the functions never convert.

import type { Annotation, AnnotationWithLayer } from '../types';
import { annotationBoxTop, ANNOTATION_BOX_HEIGHT } from './helpers';

/** The shortest an annotation may be resized to. */
export const MIN_ANNOTATION_SEC = 0.05;

/** Which edge(s) of an annotation a delta moves. */
export type EdgeSide = 'start' | 'end' | 'both';

/** The interval an annotation must stay inside (its subset span, the track). */
export interface SpanLimits { lo: number; hi: number }

/** The range of deltas one annotation can take. */
export interface DeltaRange { min: number; max: number }

/** A right-drag selection box: time on x, container-local pixels on y, in either corner order. */
export interface MarqueeBox { t0: number; y0: number; t1: number; y1: number }

/** Ids of the annotations whose boxes the marquee touches, in the order given. */
export function annotationsInBox(annotations: readonly AnnotationWithLayer[], box: MarqueeBox): string[] {
  const t0 = Math.min(box.t0, box.t1);
  const t1 = Math.max(box.t0, box.t1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  return annotations
    .filter(a => {
      const top = annotationBoxTop(a.layerIndex);
      return a.start <= t1 && a.end >= t0 && top <= y1 && top + ANNOTATION_BOX_HEIGHT >= y0;
    })
    .map(a => a.id);
}

/** `id` added to `ids`, or removed if already there. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
}

/**
 * The duration every listed annotation shares, or null if they differ (or none
 * is found). Exact to float noise only: two annotations that merely read the
 * same at two decimals are not "the same value".
 */
export function commonDuration(
  annotations: readonly Annotation[],
  ids: readonly string[],
  epsilon = 1e-6,
): number | null {
  const members = annotations.filter(a => ids.includes(a.id));
  if (members.length === 0) return null;
  const first = members[0].end - members[0].start;
  return members.every(a => Math.abs(a.end - a.start - first) <= epsilon) ? first : null;
}

/** What delta `a` can take when moving `side` and staying inside `span`. */
export function deltaRange(a: Annotation, side: EdgeSide, span: SpanLimits): DeltaRange {
  if (side === 'both') return { min: span.lo - a.start, max: span.hi - a.end };
  if (side === 'start') return { min: span.lo - a.start, max: a.end - MIN_ANNOTATION_SEC - a.start };
  return { min: a.start + MIN_ANNOTATION_SEC - a.end, max: span.hi - a.end };
}

/**
 * `want` held inside every member's range at once. Where the ranges don't
 * overlap (a span narrower than the minimum length) the lower bound wins, as a
 * single annotation's clamp always has.
 */
export function clampSharedDelta(want: number, ranges: readonly DeltaRange[]): number {
  let lo = -Infinity;
  let hi = Infinity;
  for (const r of ranges) {
    lo = Math.max(lo, r.min);
    hi = Math.min(hi, r.max);
  }
  return Math.max(lo, Math.min(want, Math.max(lo, hi)));
}

/** `annotations` with `delta` applied to `side` of each annotation in `ids`. */
export function shiftAnnotations(
  annotations: readonly Annotation[],
  ids: ReadonlySet<string>,
  side: EdgeSide,
  delta: number,
): Annotation[] {
  return annotations.map(a => {
    if (!ids.has(a.id)) return a;
    return {
      ...a,
      start: side === 'end' ? a.start : a.start + delta,
      end: side === 'start' ? a.end : a.end + delta,
    };
  });
}

/**
 * Every annotation in `ids` set to length `dur`, anchored on its start.
 * `limitEnd` says how far an annotation's end may reach (its span's end);
 * one that can't grow at all keeps its bounds.
 */
export function withDuration(
  annotations: readonly Annotation[],
  ids: ReadonlySet<string>,
  dur: number,
  limitEnd: (a: Annotation) => number,
): Annotation[] {
  return annotations.map(a => {
    if (!ids.has(a.id)) return a;
    const end = Math.min(a.start + dur, limitEnd(a));
    return end > a.start ? { ...a, end } : a;
  });
}
