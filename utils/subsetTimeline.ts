// Display time ↔ source time.
//
// Subset mode ("show only the frames where a neuron fired") hides stretches of
// the track. Rather than mask them in place, the hidden stretches are removed
// from the time axis entirely: what's left is butted together into one shorter,
// contiguous timeline, exactly as if the kept audio had been concatenated into a
// new file. That's what makes playback and navigation seamless — there is no gap
// to skip over, because the gap isn't on the axis.
//
// Two coordinate systems result:
//
//   source time   position in the media file on disk. What Rust decodes, what
//                 annotations are stored in, what buzzdetect frame starts mean.
//   display time  position on the timeline the user sees. What the viewport,
//                 the playhead, the selection, and the spectrogram's x-axis are
//                 all in.
//
// A `Timeline` is the piecewise map between them. Each `Span` is one kept run of
// source time, placed at `dispStart` on the display axis; within a span the map
// is a pure offset (slope 1), so nothing is stretched or resampled — a second of
// audio is a second wide at every zoom, in both systems.
//
// The identity timeline (subset off) is a single span covering the whole file,
// so `toDisplay`/`toSource` are the identity function and every caller can run
// the same code path whether or not subset mode is on. That's deliberate: there
// is no "if subsetting" branch scattered through the render and transport code.
//
// Spans are sorted, non-overlapping, and non-empty, so every lookup here is a
// binary search.

export interface Span {
  /** Start of the kept run, in source time (seconds). */
  srcStart: number;
  /** End of the kept run, in source time (seconds), exclusive. */
  srcEnd: number;
  /** Where this run begins on the display axis (seconds). */
  dispStart: number;
}

export interface Timeline {
  /** True when display time and source time are the same thing (subset off). */
  readonly identity: boolean;
  readonly spans: readonly Span[];
  /** Length of the display axis: the total kept duration. */
  readonly duration: number;
  /** Length of the underlying media file. */
  readonly sourceDuration: number;

  /**
   * Source → display. Times inside a hidden stretch have no display position of
   * their own, so they clamp to the end of the preceding span (or 0 before the
   * first). Callers that care about the difference test `isKept` first.
   */
  toDisplay(src: number): number;
  /** Display → source. Clamped to [0, sourceDuration]. */
  toSource(disp: number): number;
  /**
   * Display → source, resolved inside the span containing `anchor`.
   *
   * A cut is one point on the display axis but two in the file — the end of one
   * span and the start of the next — and `toSource` alone can only pick one of
   * them. An interval's END must resolve to the end of ITS span, not the start
   * of the next one, or a selection that stops exactly at a cut silently becomes
   * a zero-length one at the far side. `anchor` (the interval's start) says which
   * span is meant.
   */
  toSourceWithin(anchor: number, disp: number): number;
  /** Whether `src` falls inside a kept span (always true for the identity timeline). */
  isKept(src: number): boolean;

  /** Index of the span containing `disp`, clamped to a real span. */
  spanIndexAtDisplay(disp: number): number;
  /**
   * The spans overlapping the display range [d0, d1), in display order. Empty
   * only when the range lies entirely outside the timeline.
   */
  spansForDisplayRange(d0: number, d1: number): Span[];
  /**
   * The spans overlapping the SOURCE (file-time) range [s0, s1) — the mirror
   * of `spansForDisplayRange`, keyed on file time instead of display time.
   * Needed anywhere a grid is anchored to the file's own absolute time (e.g. a
   * buzzdetect bucket width): flooring the display axis directly floors a
   * DIFFERENT grid once spans have been spliced together, because a span's
   * display start is wherever the kept audio before it happened to add up to,
   * essentially never a multiple of the grid's own width in file time.
   */
  spansForSourceRange(s0: number, s1: number): Span[];
  /**
   * `disp`, clamped to the span containing `anchor`. This is what keeps a drag
   * from crossing a cut: two runs that are adjacent on screen are not adjacent
   * in the file, so a selection spanning them would name audio the user never
   * saw. Selections and annotations stay inside one span.
   */
  clampToSpanOfDisplay(anchor: number, disp: number): number;
}

/** Index of the last span whose `key` is <= `t`, or 0 when `t` precedes all. */
function lastSpanAtOrBefore(spans: readonly Span[], t: number, key: (s: Span) => number): number {
  let lo = 0;
  let hi = spans.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(spans[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

class SpanTimeline implements Timeline {
  readonly identity: boolean;
  readonly spans: readonly Span[];
  readonly duration: number;
  readonly sourceDuration: number;

  constructor(spans: Span[], sourceDuration: number, identity: boolean) {
    this.spans = spans;
    this.sourceDuration = sourceDuration;
    this.identity = identity;
    const last = spans[spans.length - 1];
    this.duration = last ? last.dispStart + (last.srcEnd - last.srcStart) : 0;
  }

  toDisplay(src: number): number {
    if (this.identity) return Math.max(0, Math.min(src, this.sourceDuration));
    if (this.spans.length === 0) return 0;
    if (src <= this.spans[0].srcStart) return 0;
    const i = lastSpanAtOrBefore(this.spans, src, s => s.srcStart);
    const s = this.spans[i];
    // Past this span's end means `src` is in the hidden stretch that follows it
    // (or past the last span): clamp to where that span ends on screen.
    if (src >= s.srcEnd) return s.dispStart + (s.srcEnd - s.srcStart);
    return s.dispStart + (src - s.srcStart);
  }

  toSource(disp: number): number {
    if (this.identity) return Math.max(0, Math.min(disp, this.sourceDuration));
    if (this.spans.length === 0) return 0;
    const i = this.spanIndexAtDisplay(disp);
    const s = this.spans[i];
    const within = disp - s.dispStart;
    return Math.max(s.srcStart, Math.min(s.srcStart + within, s.srcEnd));
  }

  toSourceWithin(anchor: number, disp: number): number {
    if (this.identity) return this.toSource(disp);
    if (this.spans.length === 0) return 0;
    const s = this.spans[this.spanIndexAtDisplay(anchor)];
    const within = Math.max(0, Math.min(disp - s.dispStart, s.srcEnd - s.srcStart));
    return s.srcStart + within;
  }

  isKept(src: number): boolean {
    if (this.identity) return src >= 0 && src <= this.sourceDuration;
    if (this.spans.length === 0) return false;
    const i = lastSpanAtOrBefore(this.spans, src, s => s.srcStart);
    const s = this.spans[i];
    return src >= s.srcStart && src < s.srcEnd;
  }

  spanIndexAtDisplay(disp: number): number {
    if (this.spans.length === 0) return 0;
    if (disp <= 0) return 0;
    return lastSpanAtOrBefore(this.spans, disp, s => s.dispStart);
  }

  spansForDisplayRange(d0: number, d1: number): Span[] {
    if (this.spans.length === 0) return [];
    const out: Span[] = [];
    for (let i = this.spanIndexAtDisplay(d0); i < this.spans.length; i++) {
      const s = this.spans[i];
      if (s.dispStart >= d1) break;
      out.push(s);
    }
    return out;
  }

  spansForSourceRange(s0: number, s1: number): Span[] {
    if (this.spans.length === 0) return [];
    const out: Span[] = [];
    const start = lastSpanAtOrBefore(this.spans, s0, s => s.srcStart);
    for (let i = start; i < this.spans.length; i++) {
      const s = this.spans[i];
      if (s.srcStart >= s1) break;
      if (s.srcEnd > s0) out.push(s);
    }
    return out;
  }

  clampToSpanOfDisplay(anchor: number, disp: number): number {
    if (this.identity) return disp;
    if (this.spans.length === 0) return disp;
    const s = this.spans[this.spanIndexAtDisplay(anchor)];
    const lo = s.dispStart;
    const hi = s.dispStart + (s.srcEnd - s.srcStart);
    return Math.max(lo, Math.min(disp, hi));
  }
}

/** The no-subset timeline: display time and source time are the same. */
export function identityTimeline(sourceDuration: number): Timeline {
  const dur = Math.max(0, sourceDuration);
  return new SpanTimeline([{ srcStart: 0, srcEnd: dur, dispStart: 0 }], dur, true);
}

/**
 * Display-time positions of the cuts between contiguous spans — the seams a
 * subset timeline splices together. Empty for the identity timeline (nothing
 * was cut) or a single-span subset (nothing to seam). Consecutive spans abut
 * on the display axis, so a span's end and the next span's start are the same
 * point: one join per interior boundary, not two.
 */
export function segmentJoins(timeline: Timeline): number[] {
  if (timeline.identity || timeline.spans.length < 2) return [];
  return timeline.spans.slice(1).map(s => s.dispStart);
}

/**
 * Build a subset timeline from kept source ranges. Ranges are sorted, clamped to
 * the file, and merged where they touch or overlap (`mergeTolerance` absorbs the
 * float round-off between one frame's end and the next one's start, so a run of
 * back-to-back detections becomes ONE span rather than a chain of abutting ones
 * — which is what makes a drag across a run of detections legal).
 *
 * Returns the identity timeline when the ranges cover everything or there's
 * nothing to subset by, so callers never have to special-case "subset on but
 * nothing hidden".
 */
export function buildSubsetTimeline(
  ranges: readonly { start: number; end: number }[],
  sourceDuration: number,
  mergeTolerance = 1e-6,
): Timeline {
  const dur = Math.max(0, sourceDuration);
  const clamped = ranges
    .map(r => ({ start: Math.max(0, Math.min(r.start, dur)), end: Math.max(0, Math.min(r.end, dur)) }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (clamped.length === 0) return new SpanTimeline([], dur, false);

  const spans: Span[] = [];
  let curStart = clamped[0].start;
  let curEnd = clamped[0].end;
  let disp = 0;
  const push = () => {
    spans.push({ srcStart: curStart, srcEnd: curEnd, dispStart: disp });
    disp += curEnd - curStart;
  };
  for (let i = 1; i < clamped.length; i++) {
    const r = clamped[i];
    if (r.start <= curEnd + mergeTolerance) {
      curEnd = Math.max(curEnd, r.end);
    } else {
      push();
      curStart = r.start;
      curEnd = r.end;
    }
  }
  push();

  if (spans.length === 1 && spans[0].srcStart <= mergeTolerance && spans[0].srcEnd >= dur - mergeTolerance) {
    return identityTimeline(dur);
  }
  return new SpanTimeline(spans, dur, false);
}

/**
 * The source ranges a display window covers, in display order — one per span the
 * window touches, clipped to the window. This is what turns "fetch the audio for
 * what's on screen" into a set of file ranges: under a subset, one screenful can
 * be scattered across the file.
 */
export function sourceRangesForDisplayRange(
  timeline: Timeline,
  d0: number,
  d1: number,
): { start: number; end: number }[] {
  if (timeline.identity) return [{ start: d0, end: d1 }];
  const out: { start: number; end: number }[] = [];
  for (const s of timeline.spansForDisplayRange(d0, d1)) {
    const len = s.srcEnd - s.srcStart;
    const lo = Math.max(d0, s.dispStart);
    const hi = Math.min(d1, s.dispStart + len);
    if (hi <= lo) continue;
    out.push({
      start: s.srcStart + (lo - s.dispStart),
      end: s.srcStart + (hi - s.dispStart),
    });
  }
  return out;
}

/**
 * Display position for a source time the user asked for — the nearest KEPT time
 * when that source time was cut out.
 *
 * A typed-in time is the one place a source time arrives from outside the
 * timeline, so it can name a stretch that isn't on the axis at all. There's no
 * position to go to, but there is an obvious intent: the nearest edge of the
 * subset. `toDisplay` alone always falls back to the preceding span, which sends
 * a time one second before the next detection all the way back to the previous
 * one.
 */
export function displayOfNearestKept(timeline: Timeline, src: number): number {
  if (timeline.identity || timeline.isKept(src)) return timeline.toDisplay(src);
  const spans = timeline.spans;
  if (spans.length === 0) return 0;
  if (src <= spans[0].srcStart) return 0;
  const i = lastSpanAtOrBefore(spans, src, s => s.srcStart);
  const prev = spans[i];
  const prevEnd = prev.dispStart + (prev.srcEnd - prev.srcStart);
  const next = spans[i + 1];
  if (!next) return prevEnd;
  return src - prev.srcEnd <= next.srcStart - src ? prevEnd : next.dispStart;
}

/**
 * The source-time interval a display interval names — what a readout shows the
 * user, since every time they can act on outside the app (a note, an export, a
 * position in the file) is a source time.
 *
 * The end is resolved inside the start's span (`toSourceWithin`): a selection
 * running exactly to a cut ends where that segment ends in the file, not at the
 * start of whatever comes next on screen. Interval ends can't cross a cut
 * anyway, so the anchor is always the right span.
 */
export function sourceIntervalOf(
  timeline: Timeline,
  start: number,
  end: number,
): { start: number; end: number } {
  if (timeline.identity) return { start, end };
  return { start: timeline.toSource(start), end: timeline.toSourceWithin(start, end) };
}

/**
 * Project a source-time interval onto the display axis, or null when it lands
 * entirely in hidden time. Used for annotations and selections: both are stored
 * in source time and drawn in display time.
 *
 * The result is clipped to the span the interval starts in — an interval that
 * runs past a cut would otherwise appear to cover the run on the far side, which
 * it doesn't.
 */
export function projectIntervalToDisplay(
  timeline: Timeline,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (timeline.identity) return { start, end };
  if (!timeline.isKept(start) && !timeline.isKept(Math.max(start, end - 1e-9))) {
    // Neither edge is visible. It still shows if it straddles a whole kept span.
    const covered = timeline.spans.find(s => s.srcStart >= start && s.srcEnd <= end);
    if (!covered) return null;
    const d = covered.dispStart;
    return { start: d, end: d + (covered.srcEnd - covered.srcStart) };
  }
  const dStart = timeline.toDisplay(start);
  const dEnd = timeline.toDisplay(end);
  const clippedEnd = timeline.clampToSpanOfDisplay(dStart, dEnd);
  if (clippedEnd <= dStart) return null;
  return { start: dStart, end: clippedEnd };
}
