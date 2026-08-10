// What a subset actually cut the file down to.
//
// Every number here is derivable from the timeline and the activations, but
// only by walking them — and the numbers are exactly what the user is steering
// by while they drag a threshold ("is this still 20 minutes of audio, or have
// I just thrown away the whole night?"). So they're computed once, next to
// each other, rather than re-derived by whichever readout wants one.
//
// `regions` counts SPANS, not kept bins: contiguous bins are merged into one
// stretch of audio by buildSubsetTimeline, and a stretch is what the user
// navigates and selects. `frames` counts the activation rows that survived,
// which is the number that matters for "how much did the model actually see
// here" — and it is NOT regions × anything, since a span may hold any number
// of frames and overlapping frames put several inside one bin.

import { BuzzdetectData } from '../types';
import { Timeline } from './subsetTimeline';

export interface SubsetStats {
  /** Seconds of audio the subset keeps. */
  keptSeconds: number;
  /** The file's own length, for the "out of" half of the readout. */
  sourceSeconds: number;
  /** Contiguous stretches of kept audio. */
  regions: number;
  /** Activation frames falling inside the kept audio. */
  frames: number;
  /** keptSeconds / sourceSeconds, 0 when the file has no length. */
  fraction: number;
}

/**
 * Stats for the subset `timeline` cut from `data`, or null when nothing is
 * subset (an identity timeline is the whole file, and "you kept 100% of the
 * file" is not worth a line of UI).
 */
export function subsetStats(
  data: BuzzdetectData | null,
  timeline: Timeline,
  sourceDuration: number,
): SubsetStats | null {
  if (timeline.identity) return null;
  let frames = 0;
  if (data) {
    for (const t of data.starts) {
      if (timeline.isKept(t)) frames++;
    }
  }
  const sourceSeconds = Math.max(0, sourceDuration);
  return {
    keptSeconds: timeline.duration,
    sourceSeconds,
    regions: timeline.spans.length,
    frames,
    fraction: sourceSeconds > 0 ? timeline.duration / sourceSeconds : 0,
  };
}
