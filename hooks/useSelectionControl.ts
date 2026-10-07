import { useCallback, type MutableRefObject } from 'react';
import type { Selection } from '../types';
import type { VideoFrameSource } from '../utils/VideoFrameSource';
import type { ActivationStackApi } from './useActivationStack';

interface SelectionControlParams {
  setSelection: (s: Selection | null) => void;
  selectionRef: MutableRefObject<Selection | null>;
  activationStack: ActivationStackApi;
  frameSourceRef: MutableRefObject<VideoFrameSource | null>;
  clearSelectionEnd: () => void;
  /** Bound a play already in flight at the new selection's end. */
  bindSelectionEnd: (s: Selection) => void;
  /** Display-time selection → source time (identity without a subset). */
  selectionToSource: (s: Selection) => Selection;
}

/**
 * The one way a window sets or clears the selection. Every path (spectrogram
 * drag, toolbar time edits, annotation clicks, Escape) goes through it, so the
 * activation stack, the frame-source pin and the transport's bounded stop stay
 * in step without each caller having to remember them.
 */
export function useSelectionControl({
  setSelection, selectionRef, activationStack, frameSourceRef, clearSelectionEnd, bindSelectionEnd, selectionToSource,
}: SelectionControlParams) {
  return useCallback((s: Selection | null) => {
    setSelection(s);
    // Sync synchronously, not just via the state-mirroring effect: a caller
    // that seeks in the same tick as committing a new selection (e.g. snapping
    // the playhead into a just-created selection) needs seek()'s bounded-restart
    // logic to see the new selection immediately, not last render's.
    selectionRef.current = s;
    if (s) {
      activationStack.pushIfAbsent('selection');
      // Pin here, not only on commit: every non-null selection flows through
      // this wrapper, whereas a commit callback only fires on a fresh
      // drag-release. Pinning keeps the selection's frames resident across the
      // rolling prefetch's eviction churn so replays hit the cache. Decoded
      // frames are indexed by position in the file, so the display-time
      // selection converts first.
      const src = selectionToSource(s);
      frameSourceRef.current?.pinSelectionRange(src.start, src.end);
      bindSelectionEnd(s);
    } else {
      activationStack.remove('selection');
      frameSourceRef.current?.clearPinnedRange();
      // The selection was driving playback's bounded stop — drop it so
      // playback continues through to EOF instead of stopping at the stale end.
      clearSelectionEnd();
    }
  }, [setSelection, selectionRef, activationStack, frameSourceRef, clearSelectionEnd, bindSelectionEnd, selectionToSource]);
}
