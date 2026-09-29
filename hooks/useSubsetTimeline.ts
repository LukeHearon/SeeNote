import { useMemo, useRef, type MutableRefObject } from 'react';
import { BuzzdetectData, Selection, VideoMode } from '../types';
import type { BuzzdetectApi } from './useBuzzdetect';
import { subsetTimelineFor, subsetBuzzdetectData, subsetCriteriaFrom, type SubsetCriteria } from '../utils/buzzdetectSubset';
import { subsetStats, type SubsetStats } from '../utils/buzzdetectStats';
import { sourceIntervalOf, type Timeline } from '../utils/subsetTimeline';

const EMPTY_STRING_LIST: string[] = [];

export interface SubsetTimelineApi {
  /** What the subset is keyed to, or null when it's off. */
  subsetCriteria: SubsetCriteria | null;
  /**
   * The display axis. Identity (the whole file, unchanged) whenever the subset
   * is off. `duration` in the params is the file's own length; `displayDuration`
   * is what the whole UI and the transport are measured in.
   */
  timeline: Timeline;
  displayDuration: number;
  /**
   * "The user has asked for a subset", as distinct from "the timeline differs
   * from the file": a subset that keeps everything still draws as a subset, and
   * one that keeps nothing is still engaged.
   */
  subsetActive: boolean;
  /**
   * The isolation the graph actually draws: the picked neurons while the master
   * switch is on, nothing otherwise — one list rather than a set and a flag.
   */
  activeIsolatedNeurons: string[];
  /** Bin width sizing the chunk grid under a subset; undefined = the default grid. */
  subsetGrainSec: number | undefined;
  /** The kept spans in source time, or null when the timeline is the identity. */
  subsetSourceRanges: { start: number; end: number }[] | null;
  /** How much audio the cut came to, for the palette's readout. */
  subsetStats: SubsetStats | null;
  /** The activations re-expressed on the display axis, keeping only the kept frames. */
  displayBuzzdetectData: BuzzdetectData | null;
  /**
   * Video is turned off outright while a subset is on: the picture can't follow
   * a timeline that jumps between distant parts of the file without stalling on
   * every join. The user's own videoMode preference is left untouched — this
   * only overrides what's in effect right now.
   */
  effectiveVideoMode: VideoMode;
  // Mirrors for callbacks and rAF loops that must not re-bind on every threshold nudge.
  effectiveVideoModeRef: MutableRefObject<VideoMode>;
  timelineRef: MutableRefObject<Timeline>;
  displayDurationRef: MutableRefObject<number>;
  subsetGrainRef: MutableRefObject<number | undefined>;
  subsetSourceRangesRef: MutableRefObject<{ start: number; end: number }[] | null>;
  /**
   * A selection is display-time everywhere (view + playback bounds); anything
   * that names audio in the file — an annotation, an export — has to be
   * converted, the same conversion the toolbar and panel readouts make.
   */
  selectionToSource: (sel: Selection) => Selection;
}

/**
 * Subset mode's derivations, shared by AnnotationWindow and SingleFileWindow:
 * the criteria the buzzdetect palette describes, the timeline they cut, and the
 * things the rest of the window reads off it. Instantiated ahead of the frame
 * source and the transport, because the timeline decides the DISPLAY duration
 * and the effective video mode — both of which those hooks need.
 */
export function useSubsetTimeline(
  buzzdetect: BuzzdetectApi,
  duration: number,
  videoMode: VideoMode,
): SubsetTimelineApi {
  const {
    buzzdetectData, buzzdetectSubsetEnabled, buzzdetectSubsetThresholds, buzzdetectThresholds,
    buzzdetectSeriesMode, buzzdetectMinDetectionRate, buzzdetectBinWidthOverride, buzzdetectSubsetBuffer,
    buzzdetectIsolateEnabled, buzzdetectIsolatedNeurons,
  } = buzzdetect;

  const subsetCriteria = useMemo<SubsetCriteria | null>(() => subsetCriteriaFrom({
    enabled: buzzdetectSubsetEnabled,
    subsetThresholds: buzzdetectSubsetThresholds,
    thresholds: buzzdetectThresholds,
    mode: buzzdetectSeriesMode,
    minDetectionRate: buzzdetectMinDetectionRate,
    binWidthOverride: buzzdetectBinWidthOverride,
    frameHop: buzzdetectData?.frameHop ?? 0,
    buffer: buzzdetectSubsetBuffer,
    availableNeurons: buzzdetectData?.neurons ?? null,
  }), [buzzdetectSubsetEnabled, buzzdetectSeriesMode, buzzdetectSubsetThresholds, buzzdetectThresholds,
      buzzdetectMinDetectionRate, buzzdetectBinWidthOverride, buzzdetectData, buzzdetectSubsetBuffer]);

  const timeline = useMemo(
    () => subsetTimelineFor(buzzdetectData, subsetCriteria, duration),
    [buzzdetectData, subsetCriteria, duration],
  );
  const displayDuration = timeline.duration;
  const subsetActive = subsetCriteria !== null;

  const activeIsolatedNeurons = useMemo(
    () => (buzzdetectIsolateEnabled ? buzzdetectIsolatedNeurons : EMPTY_STRING_LIST),
    [buzzdetectIsolateEnabled, buzzdetectIsolatedNeurons],
  );

  // The cache needs two things from the subset, on different clocks:
  //
  //   grain   the bin width, which sizes the chunk grid (see buildTierLadder).
  //           Changing it invalidates every cached chunk, so the cache is
  //           rebuilt — but it only moves when the user changes bin width or
  //           turns the subset on/off, not when they drag a threshold.
  //   ranges  the kept spans, which cap each tier's LRU at the subset's own
  //           footprint. These move on every threshold nudge and are applied to
  //           the live cache without dropping anything.
  const subsetGrainSec = subsetCriteria && subsetCriteria.binWidth > 0
    ? subsetCriteria.binWidth
    : undefined;
  const subsetSourceRanges = useMemo(
    () => (timeline.identity ? null : timeline.spans.map(s => ({ start: s.srcStart, end: s.srcEnd }))),
    [timeline],
  );
  // Walks the frames once per timeline — i.e. per threshold nudge, on the same
  // clock the timeline itself is rebuilt on, so it costs nothing the subset didn't.
  const stats = useMemo(
    () => subsetStats(buzzdetectData, timeline, duration),
    [buzzdetectData, timeline, duration],
  );

  const subsetGrainRef = useRef(subsetGrainSec);
  subsetGrainRef.current = subsetGrainSec;
  const subsetSourceRangesRef = useRef(subsetSourceRanges);
  subsetSourceRangesRef.current = subsetSourceRanges;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const displayDurationRef = useRef(displayDuration);
  displayDurationRef.current = displayDuration;

  const effectiveVideoMode: VideoMode = subsetActive ? 'off' : videoMode;
  const effectiveVideoModeRef = useRef(effectiveVideoMode);
  effectiveVideoModeRef.current = effectiveVideoMode;

  // The panel is handed only the frames the subset kept, so it plots the subset
  // without knowing one exists (see utils/buzzdetectSubset.ts).
  const displayBuzzdetectData = useMemo(
    () => subsetBuzzdetectData(buzzdetectData, timeline),
    [buzzdetectData, timeline],
  );

  const selectionToSource = useMemo(
    () => (sel: Selection): Selection => sourceIntervalOf(timeline, sel.start, sel.end),
    [timeline],
  );

  return {
    subsetCriteria, timeline, displayDuration, subsetActive, activeIsolatedNeurons,
    subsetGrainSec, subsetSourceRanges, subsetStats: stats, displayBuzzdetectData,
    effectiveVideoMode, effectiveVideoModeRef, timelineRef, displayDurationRef,
    subsetGrainRef, subsetSourceRangesRef, selectionToSource,
  };
}
