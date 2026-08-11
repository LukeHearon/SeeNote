import { useCallback } from 'react';
import { Selection } from '../types';
import { clamp } from '../utils/helpers';
import { extendSelection, scrubTarget } from '../utils/selectionExtend';
import { useHotkeys } from './useHotkeys';

interface UseSelectionKeyboardArgs {
  selectionRef: React.MutableRefObject<Selection | null>;
  currentTimeRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  /** Visible-window width in seconds — the Shift+arrow nudge is 10% of it. */
  zoomSecRef: React.MutableRefObject<number>;
  seek: (time: number, scrollView?: boolean) => void;
  onSelectionChange: (s: Selection | null) => void;
  enabled?: boolean;
}

/**
 * Shift+arrow selection extending, the keyboard counterpart of Shift+click:
 * the selection spans from a fixed anchor to wherever the playhead has been
 * moved. Shift+←/→ nudges by the same step as a plain arrow scrub, Shift+Mod+
 * ←/→ runs to the track's start/end.
 *
 * Registered by both windows next to their own selection setter, so an extend
 * goes through the same wrapper (activation stack, frame pinning) as any other
 * selection change.
 */
export function useSelectionKeyboard({
  selectionRef,
  currentTimeRef,
  durationRef,
  zoomSecRef,
  seek,
  onSelectionChange,
  enabled = true,
}: UseSelectionKeyboardArgs): void {
  const extendTo = useCallback((time: number, scrollView = false) => {
    const target = clamp(time, 0, durationRef.current);
    // Selection first: it updates `selectionRef` synchronously, so a seek made
    // while playing restarts bounded by the new selection, not the old one.
    onSelectionChange(extendSelection(selectionRef.current, currentTimeRef.current, target));
    seek(target, scrollView);
  }, [durationRef, selectionRef, currentTimeRef, onSelectionChange, seek]);

  useHotkeys([
    { key: 'ArrowLeft', mods: ['shift'], handler: () =>
        extendTo(scrubTarget(currentTimeRef.current, durationRef.current, zoomSecRef.current, -1)) },
    { key: 'ArrowRight', mods: ['shift'], handler: () =>
        extendTo(scrubTarget(currentTimeRef.current, durationRef.current, zoomSecRef.current, 1)) },
    { key: 'ArrowLeft', mods: ['shift', 'mod'], handler: () => extendTo(0, true) },
    { key: 'ArrowRight', mods: ['shift', 'mod'], handler: () => extendTo(durationRef.current, true) },
  ], enabled);
}
