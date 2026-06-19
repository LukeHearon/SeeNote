import { useCallback, useRef, MutableRefObject } from 'react';
import { Annotation } from '../types';

export interface AnnotationHistoryApi {
  /** Undo/redo stack of annotation snapshots. Reset directly by track-open /
   *  load / project-change paths, so the refs themselves are exposed. */
  annotationsHistoryRef: MutableRefObject<Annotation[][]>;
  historyIndexRef: MutableRefObject<number>;
  /** Append a snapshot, truncating any redo tail. */
  pushAnnotationsToHistory: (newAnnotations: Annotation[]) => void;
  /** Final update — sets state and pushes to history. */
  handleAnnotationsCommit: (newAnnotations: Annotation[]) => void;
  undoAnnotations: () => void;
  redoAnnotations: () => void;
}

/**
 * Undo/redo stack for annotations. Holds the history refs and the four
 * commit/undo/redo helpers extracted from AnnotationWindow. The owning
 * component passes its `annotations` setter; history reset (on track open,
 * annotation load, project change) is done by writing the returned refs.
 */
export function useAnnotationHistory(
  setAnnotations: (annotations: Annotation[]) => void,
): AnnotationHistoryApi {
  // Undo/redo history for annotations
  const annotationsHistoryRef = useRef<Annotation[][]>([[]]);
  const historyIndexRef = useRef<number>(0);

  // Annotation history helpers
  const pushAnnotationsToHistory = useCallback((newAnnotations: Annotation[]) => {
    annotationsHistoryRef.current = annotationsHistoryRef.current.slice(0, historyIndexRef.current + 1);
    annotationsHistoryRef.current.push(newAnnotations);
    historyIndexRef.current = annotationsHistoryRef.current.length - 1;
  }, []);

  // Final update — pushes to history (called on mouse release, delete, etc.)
  const handleAnnotationsCommit = useCallback((newAnnotations: Annotation[]) => {
    setAnnotations(newAnnotations);
    pushAnnotationsToHistory(newAnnotations);
  }, [pushAnnotationsToHistory, setAnnotations]);

  const undoAnnotations = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    setAnnotations(annotationsHistoryRef.current[historyIndexRef.current]);
  }, [setAnnotations]);

  const redoAnnotations = useCallback(() => {
    if (historyIndexRef.current >= annotationsHistoryRef.current.length - 1) return;
    historyIndexRef.current++;
    setAnnotations(annotationsHistoryRef.current[historyIndexRef.current]);
  }, [setAnnotations]);

  return {
    annotationsHistoryRef,
    historyIndexRef,
    pushAnnotationsToHistory,
    handleAnnotationsCommit,
    undoAnnotations,
    redoAnnotations,
  };
}
