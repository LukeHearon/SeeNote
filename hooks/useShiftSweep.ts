import { useCallback, useEffect, useRef } from 'react';
import { Selection } from '../types';

/**
 * How long Shift must be held for the sweep to count. Below this it was a
 * modifier press on the way to something else (or a stray tap), and turning it
 * into a selection would bound the playback the user is listening to.
 */
const SWEEP_GRACE_MS = 300;
/** A sweep shorter than this is nothing worth selecting. */
const SWEEP_MIN_SEC = 0.05;

interface UseShiftSweepArgs {
  isPlaying: boolean;
  selectionRef: React.MutableRefObject<Selection | null>;
  currentTimeRef: React.MutableRefObject<number>;
  onSelectionChange: (s: Selection | null) => void;
  /**
   * Where the in-progress sweep started, or null. The spectrogram draws the
   * span from here to the live playhead — the selection itself isn't made until
   * the key comes up, so playback isn't bounded mid-sweep.
   */
  onSweepStartChange: (start: number | null) => void;
  enabled?: boolean;
}

/**
 * Hold Shift while listening to mark out what you're hearing: the press drops
 * the start, the playhead carries the end, and the release makes the selection.
 *
 * Only when nothing is selected already — with a selection up, Shift belongs to
 * the arrow-key extend (useArrowKeys).
 */
export function useShiftSweep({
  isPlaying,
  selectionRef,
  currentTimeRef,
  onSelectionChange,
  onSweepStartChange,
  enabled = true,
}: UseShiftSweepArgs): void {
  const cbRef = useRef({ onSelectionChange, onSweepStartChange });
  cbRef.current = { onSelectionChange, onSweepStartChange };

  const sweepRef = useRef<{ start: number; pressedAt: number } | null>(null);

  const cancelSweep = useCallback(() => {
    if (!sweepRef.current) return;
    sweepRef.current = null;
    cbRef.current.onSweepStartChange(null);
  }, []);

  useEffect(() => {
    if (!enabled) { cancelSweep(); return; }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') {
        // Shift turned out to be a modifier for something else (Shift+S,
        // Shift+arrow, a tool key) — that press owns the gesture, not this.
        cancelSweep();
        return;
      }
      if (e.repeat) return;
      if (!isPlaying || selectionRef.current || sweepRef.current) return;
      sweepRef.current = { start: currentTimeRef.current, pressedAt: performance.now() };
      cbRef.current.onSweepStartChange(sweepRef.current.start);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const sweep = sweepRef.current;
      if (!sweep) return;
      cancelSweep();
      const end = currentTimeRef.current;
      const held = performance.now() - sweep.pressedAt;
      if (held < SWEEP_GRACE_MS) return;
      if (Math.abs(end - sweep.start) < SWEEP_MIN_SEC) return;
      cbRef.current.onSelectionChange({
        start: Math.min(sweep.start, end),
        end: Math.max(sweep.start, end),
      });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', cancelSweep);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', cancelSweep);
      cancelSweep();
    };
  }, [enabled, isPlaying, selectionRef, currentTimeRef, cancelSweep]);

  // Pausing mid-hold leaves the end frozen wherever the clock stopped; the
  // sweep is about what's being heard, so it ends with the playback.
  useEffect(() => {
    if (!isPlaying) cancelSweep();
  }, [isPlaying, cancelSweep]);
}
