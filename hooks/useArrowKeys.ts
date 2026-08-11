import { useCallback, useEffect, useRef } from 'react';
import { Selection } from '../types';
import { clamp } from '../utils/helpers';
import { rampVelocityPx, scrubTarget } from '../utils/arrowScrub';
import { extendSelection } from '../utils/selectionExtend';
import { useHotkeys } from './useHotkeys';

/** Idle time after the last arrow movement before the gesture counts as finished. */
const SETTLE_MS = 400;

interface UseArrowKeysArgs {
  selectionRef: React.MutableRefObject<Selection | null>;
  currentTimeRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  /** Visible-window width in seconds — the coarse scrub is 10% of it. */
  zoomSecRef: React.MutableRefObject<number>;
  /** The spectrogram's live time→pixel scale, for the fine per-pixel ramp. */
  getPixelsPerSecond: () => number;
  seek: (time: number, scrollView?: boolean) => void;
  onSelectionChange: (s: Selection | null) => void;
  /**
   * Called once a run of Shift+arrow presses has gone quiet — the moment to
   * push whatever the extend was editing (a bound annotation) into undo
   * history, so a burst of keypresses is one undoable operation.
   */
  onExtendSettled?: () => void;
  /** Ramping is paused-only: every step seeks, and a seek mid-playback restarts the engine. */
  isPlaying: boolean;
  enabled?: boolean;
}

/**
 * Every arrow-key playhead movement, in one owner (they share a keydown, so
 * they cannot be split across hooks — useHotkeys fires every match).
 *
 *  - No selection, no Shift: coarse scrub, 10% of the visible window per press.
 *  - Selection active: fine move — one pixel per tap, accelerating while held.
 *    Placing a playhead against a selection edge is pixel work, and the coarse
 *    jump overshoots it every time.
 *  - Shift: the same fine move, dragging a selection out behind it from a fixed
 *    anchor (see utils/selectionExtend) — the keyboard twin of Shift+click.
 *  - {mod}+Shift: extend straight to the start/end of the track.
 *
 * While playback is running every press is a coarse step instead — the ramp
 * seeks each frame, and a seek mid-play restarts the engine.
 *
 * Registered by both windows next to their own selection setter, so an extend
 * goes through the same wrapper (activation stack, frame pinning) as any other
 * selection change.
 */
export function useArrowKeys({
  selectionRef,
  currentTimeRef,
  durationRef,
  zoomSecRef,
  getPixelsPerSecond,
  seek,
  onSelectionChange,
  onExtendSettled,
  isPlaying,
  enabled = true,
}: UseArrowKeysArgs): void {
  // Callbacks are re-read per frame rather than captured: a ramp outlives many
  // renders, and each step must land on the latest state.
  const cbRef = useRef({ seek, onSelectionChange, onExtendSettled, getPixelsPerSecond });
  cbRef.current = { seek, onSelectionChange, onExtendSettled, getPixelsPerSecond };

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const rampRef = useRef<{ dir: -1 | 1; extend: boolean; raf: number } | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  // Whether anything has been extended since the last settle — nothing to
  // commit otherwise.
  const dirtyRef = useRef(false);

  const settleNow = useCallback(() => {
    if (settleTimerRef.current !== null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    cbRef.current.onExtendSettled?.();
  }, []);

  const scheduleSettle = useCallback(() => {
    if (!dirtyRef.current) return;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(settleNow, SETTLE_MS);
  }, [settleNow]);

  const moveTo = useCallback((target: number, extend: boolean, scrollView = false) => {
    const t = clamp(target, 0, durationRef.current);
    if (extend) {
      // Selection first: it updates `selectionRef` synchronously, so a seek made
      // while playing restarts bounded by the new selection, not the old one.
      cbRef.current.onSelectionChange(extendSelection(selectionRef.current, currentTimeRef.current, t));
      dirtyRef.current = true;
    }
    cbRef.current.seek(t, scrollView);
    scheduleSettle();
  }, [durationRef, selectionRef, currentTimeRef, scheduleSettle]);

  const movePixels = useCallback((dir: -1 | 1, extend: boolean, px: number) => {
    const pps = Math.max(cbRef.current.getPixelsPerSecond(), 1);
    moveTo(currentTimeRef.current + dir * (px / pps), extend);
  }, [moveTo, currentTimeRef]);

  const stopRamp = useCallback(() => {
    if (!rampRef.current) return;
    cancelAnimationFrame(rampRef.current.raf);
    rampRef.current = null;
    scheduleSettle();
  }, [scheduleSettle]);

  const startRamp = useCallback((dir: -1 | 1, extend: boolean) => {
    stopRamp();
    // The tap itself: exactly one pixel, however briefly the key is held.
    movePixels(dir, extend, 1);
    const heldStart = performance.now();
    let last = heldStart;
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const velocity = rampVelocityPx((now - heldStart) / 1000);
      if (velocity > 0) movePixels(dir, extend, velocity * dt);
      if (rampRef.current) rampRef.current.raf = requestAnimationFrame(tick);
    };
    rampRef.current = { dir, extend, raf: requestAnimationFrame(tick) };
  }, [stopRamp, movePixels]);

  const onArrow = useCallback((e: KeyboardEvent, dir: -1 | 1, extend: boolean) => {
    // Coarse: one 10%-of-window jump per press (including the OS's own key
    // repeats). Used when there's no selection to work against, and whenever
    // the engine is running — a ramp seeks every frame, and each seek mid-play
    // restarts playback.
    if ((!extend && !selectionRef.current) || isPlayingRef.current) {
      stopRamp();
      moveTo(scrubTarget(currentTimeRef.current, durationRef.current, zoomSecRef.current, dir), extend);
      return;
    }
    const ramp = rampRef.current;
    if (ramp && ramp.dir === dir && ramp.extend === extend) return; // already running
    // OS key repeats are ignored: the ramp, not the repeat rate, sets the pace.
    if (e.repeat && ramp) return;
    startRamp(dir, extend);
  }, [selectionRef, currentTimeRef, durationRef, zoomSecRef, stopRamp, startRamp, moveTo]);

  useHotkeys([
    { key: 'ArrowLeft', handler: e => onArrow(e, -1, false) },
    { key: 'ArrowRight', handler: e => onArrow(e, 1, false) },
    { key: 'ArrowLeft', mods: ['shift'], handler: e => onArrow(e, -1, true) },
    { key: 'ArrowRight', mods: ['shift'], handler: e => onArrow(e, 1, true) },
    { key: 'ArrowLeft', mods: ['shift', 'mod'], handler: () => { stopRamp(); moveTo(0, true, true); } },
    { key: 'ArrowRight', mods: ['shift', 'mod'], handler: () => { stopRamp(); moveTo(durationRef.current, true, true); } },
  ], enabled);

  useEffect(() => {
    if (isPlaying) stopRamp();
  }, [isPlaying, stopRamp]);

  // A ramp runs until its key comes up. Releasing Shift also ends it — the
  // gesture it was in the middle of no longer describes what's being asked for.
  useEffect(() => {
    if (!enabled) { stopRamp(); settleNow(); return; }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Shift') stopRamp();
    };
    // Losing focus mid-hold gives no keyup at all, so land the gesture here.
    const onBlur = () => { stopRamp(); settleNow(); };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      stopRamp();
      settleNow();
    };
  }, [enabled, stopRamp, settleNow]);
}
