// Annotations across the display↔source seam.
//
// Annotations are stored — and exported, and synced — in source time: they name
// positions in the media file, and must keep naming the same positions no matter
// what the viewport is currently showing. But the spectrogram, its overlay, and
// every drag gesture work in display time.
//
// So annotations are projected on the way in and reconciled on the way out. The
// reconcile is not simply the inverse projection, because that would be lossy:
//   - An annotation sitting in hidden time has no display position at all. It
//     isn't handed to the overlay, so it can't come back from it either — it's
//     carried across untouched rather than being read as a deletion.
//   - An annotation whose bounds the user did NOT touch keeps its stored source
//     bounds exactly. Round-tripping every annotation through the projection on
//     every edit would quantise untouched neighbours to span edges.
// Both are no-ops on the identity timeline, which is the whole-file case.

import { Annotation } from '../types';
import { Timeline, projectIntervalToDisplay } from './subsetTimeline';

/** How close a returned bound must be to its projection to count as untouched. */
const UNTOUCHED_EPSILON = 1e-9;

export interface ProjectedAnnotations {
  /** Annotations with a display position, in display time. Handed to the view. */
  shown: Annotation[];
  /** Annotations that fall entirely in hidden time. Held back, never edited. */
  hidden: Annotation[];
}

export function projectAnnotations(
  annotations: readonly Annotation[],
  timeline: Timeline,
): ProjectedAnnotations {
  if (timeline.identity) return { shown: annotations as Annotation[], hidden: [] };
  const shown: Annotation[] = [];
  const hidden: Annotation[] = [];
  for (const a of annotations) {
    const span = projectIntervalToDisplay(timeline, a.start, a.end);
    if (span) shown.push({ ...a, start: span.start, end: span.end });
    else hidden.push(a);
  }
  return { shown, hidden };
}

/**
 * Fold the view's display-time annotations back into source time.
 *
 * `previous` is the source-time list the view was rendering, keyed by id, so an
 * annotation whose bounds came back unchanged keeps its stored values rather
 * than being re-derived. `hidden` is re-added — those were never on screen, so
 * their absence from `displayed` says nothing.
 *
 * A bound that DID move converts through the timeline, clamped to the span its
 * start lands in: an annotation may not straddle a cut, since the audio on the
 * far side isn't the audio it appears to cover.
 */
export function reconcileAnnotations(
  displayed: readonly Annotation[],
  previous: readonly Annotation[],
  hidden: readonly Annotation[],
  timeline: Timeline,
): Annotation[] {
  if (timeline.identity) return displayed as Annotation[];

  const prevById = new Map(previous.map(a => [a.id, a]));
  const out: Annotation[] = [];
  for (const d of displayed) {
    const prev = prevById.get(d.id);
    if (prev) {
      const projected = projectIntervalToDisplay(timeline, prev.start, prev.end);
      const untouched =
        projected !== null &&
        Math.abs(projected.start - d.start) <= UNTOUCHED_EPSILON &&
        Math.abs(projected.end - d.end) <= UNTOUCHED_EPSILON;
      if (untouched) {
        out.push({ ...d, start: prev.start, end: prev.end });
        continue;
      }
    }
    out.push({
      ...d,
      start: timeline.toSource(d.start),
      end: timeline.toSourceWithin(d.start, d.end),
    });
  }
  out.push(...hidden);
  out.sort((a, b) => a.start - b.start);
  return out;
}
