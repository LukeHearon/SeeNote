import { useCallback, useMemo } from 'react';
import type React from 'react';
import type { Annotation, Selection } from '../types';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import { clamp } from '../utils/helpers';
import { mergeStops, prevStop, nextStop } from '../utils/jumpStops';
import { maxScroll as computeMaxScroll } from '../utils/viewportTransform';

interface AnnotationJumpsParams {
  annotations: Annotation[];
  subsetJoins: number[];
  selection: Selection | null;
  duration: number;
  currentTimeStore: CurrentTimeStore;
  containerRef: React.RefObject<HTMLDivElement>;
  containerSizeRef: React.MutableRefObject<{ width: number; height: number }>;
  pixelsPerSecondRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  setScroll: (v: number, source?: string) => void;
  onSeek: (t: number) => void;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
}

/**
 * The spectrogram's jump actions: previous/next annotation (stopping at a
 * selection's edges first, and at subset joins), and track start/end. Each
 * seeks and scrolls the target into view.
 */
export function useAnnotationJumps({
  annotations, subsetJoins, selection, duration, currentTimeStore,
  containerRef, containerSizeRef, pixelsPerSecondRef, durationRef, setScroll,
  onSeek, onSelectionChange, onBoundAnnotationChange,
}: AnnotationJumpsParams) {
  // Annotation starts plus, under a subset, the segment joins.
  const jumpStops = useMemo(() => mergeStops(annotations.map(a => a.start), subsetJoins), [annotations, subsetJoins]);

  // Puts the annotation a quarter of the way in, clamped like every other scroll.
  // Live pps: during a zoom commit the prop lags the ref.
  const scrollToAnnotation = useCallback((annotStart: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerSizeRef.current.width || containerRef.current.clientWidth;
    const pps = pixelsPerSecondRef.current;
    const target = annotStart * pps - containerWidth * 0.25;
    setScroll(clamp(target, 0, computeMaxScroll(durationRef.current, pps, containerWidth)), 'scrollToAnnotation');
  }, [setScroll]);

  const goToPrevAnnotation = useCallback(() => {
    if (selection !== null) {
      const t = currentTimeStore.get();
      if (Math.abs(t - selection.start) <= 0.05) {
        // Second press: already at selection start — clear selection and fall through to prev annotation
        onSelectionChange(null);
        onBoundAnnotationChange(null);
      } else {
        // First press: jump to selection start
        onSeek(selection.start);
        scrollToAnnotation(selection.start);
        return;
      }
    }
    const prev = prevStop(jumpStops, currentTimeStore.get());
    onSeek(prev);
    scrollToAnnotation(prev);
  }, [jumpStops, currentTimeStore, onSeek, scrollToAnnotation, selection, onSelectionChange, onBoundAnnotationChange]);

  const goToNextAnnotation = useCallback(() => {
    // Any active selection (free or bound): jump to selection end
    if (selection !== null) {
      onSeek(selection.end);
      scrollToAnnotation(selection.end);
      return;
    }
    const next = nextStop(jumpStops, currentTimeStore.get(), duration);
    onSeek(next);
    scrollToAnnotation(next);
  }, [jumpStops, currentTimeStore, duration, onSeek, scrollToAnnotation, selection]);

  // Track start/end: unlike prev/next annotation, these always clear any
  // active selection/binding rather than jumping to its edge first — they're
  // an unconditional "go to the absolute start/end" action.
  const goToTrackStart = useCallback(() => {
    onSeek(0);
    scrollToAnnotation(0);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  }, [onSeek, scrollToAnnotation, onSelectionChange, onBoundAnnotationChange]);

  const goToTrackEnd = useCallback(() => {
    onSeek(duration);
    scrollToAnnotation(duration);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  }, [onSeek, scrollToAnnotation, duration, onSelectionChange, onBoundAnnotationChange]);

  return { goToPrevAnnotation, goToNextAnnotation, goToTrackStart, goToTrackEnd };
}
