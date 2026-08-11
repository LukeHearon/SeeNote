import { useCallback, useEffect, useRef } from 'react';
import type { Selection } from '../types';

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
  /** Stop playback. A finished selection is something to look at, not listen past. */
  pause: () => void;
  selectionRef: React.MutableRefObject<Selection | null>;
  currentTimeRef: React.MutableRefObject<number>;
  /**
   * Commit the swept span — Spectrogram's commitSpan, so a sweep means exactly
   * what the same span drawn with the mouse would: an annotation when a tool is
   * readied, a selection otherwise. `quiet` is Alt's "don't disturb the listen".
   */
  onCommitSpan: (anchor: number, edge: number, quiet?: boolean) => void;
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
 * the start, the playhead carries the end, and the release commits the span —
 * an annotation if a tool is readied, a selection otherwise, exactly as the
 * same span drawn with the mouse would.
 *
 * Only when nothing is selected already — with a selection up, Shift belongs to
 * the arrow-key extend (useArrowKeys).
 */
export function useShiftSweep({
  isPlaying,
  pause,
  selectionRef,
  currentTimeRef,
  onCommitSpan,
  onSweepStartChange,
  enabled = true,
}: UseShiftSweepArgs): void {
  const cbRef = useRef({ onCommitSpan, onSweepStartChange, pause });
  cbRef.current = { onCommitSpan, onSweepStartChange, pause };

  const sweepRef = useRef<{ start: number; pressedAt: number } | null>(null);
  // The span only becomes visible once the press has outlived the grace period.
  // Showing it from the keydown made every Shift tap flash the selection veil
  // over the spectrogram.
  const showTimerRef = useRef<number | null>(null);

  const cancelSweep = useCallback(() => {
    if (showTimerRef.current !== null) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    if (!sweepRef.current) return;
    sweepRef.current = null;
    cbRef.current.onSweepStartChange(null);
  }, []);

  useEffect(() => {
    if (!enabled) { cancelSweep(); return; }

    const onKeyDown = (e: KeyboardEvent) => {
      // Other modifiers are readings of the same gesture, not competitors:
      // Alt in particular is how the user says "keep playing" on release.
      if (e.key === 'Alt' || e.key === 'Meta' || e.key === 'Control') return;
      if (e.key !== 'Shift') {
        // Shift turned out to be a modifier for something else (Shift+S,
        // Shift+arrow, a tool key) — that press owns the gesture, not this.
        cancelSweep();
        return;
      }
      if (e.repeat) return;
      if (!isPlaying || selectionRef.current || sweepRef.current) return;
      const start = currentTimeRef.current;
      sweepRef.current = { start, pressedAt: performance.now() };
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (sweepRef.current) cbRef.current.onSweepStartChange(sweepRef.current.start);
      }, SWEEP_GRACE_MS);
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
      // Alt is the "keep listening" escape hatch, the same one Alt-drag
      // annotation has: playback rolls on and the commit stays quiet.
      cbRef.current.onCommitSpan(sweep.start, end, e.altKey);
      if (!e.altKey) cbRef.current.pause();
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
