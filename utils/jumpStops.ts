// Alt+←/→ jump targets. Annotation starts are the primary stops; under a subset
// the segment joins are stops too, so the same keys walk to the start of each
// kept chunk when no annotation lies in between.

/** How close (s) the playhead must be to a stop to count as already on it. */
export const JUMP_EPSILON = 0.05;

/** Merge stop times into one sorted list. */
export function mergeStops(...lists: readonly (readonly number[])[]): number[] {
  return lists.flat().sort((a, b) => a - b);
}

/** Last stop before `t` (outside epsilon), or 0. `stops` must be sorted. */
export function prevStop(stops: readonly number[], t: number): number {
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i] < t - JUMP_EPSILON) return stops[i];
  }
  return 0;
}

/** First stop after `t` (outside epsilon), or `end`. `stops` must be sorted. */
export function nextStop(stops: readonly number[], t: number, end: number): number {
  for (const s of stops) {
    if (s > t + JUMP_EPSILON) return s;
  }
  return end;
}
