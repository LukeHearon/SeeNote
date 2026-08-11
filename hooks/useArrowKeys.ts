import { useCallback, useEffect, useRef } from 'react';
import { Selection } from '../types';
import { clamp } from '../utils/helpers';
import { rampVelocityPx, scrubTarget } from '../utils/arrowScrub';
import { ExtendGesture, extendGestureFor, spanBetween } from '../utils/selectionExtend';
import { useHotkeys } from './useHotkeys';

/** Idle time after the last arrow movement before the gesture counts as finished. */
const SETTLE_MS = 400;
/** Longest plausible gap between OS key repeats; past it, a held key isn't held. */
const KEY_REPEAT_GAP_MS = 1200;

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
  /**
   * Playback pins the playhead to the media clock, so nothing here moves it or
   * builds a selection around it while the engine runs — Shift during playback
   * belongs to the sweep gesture instead (useShiftSweep).
   */
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
 *  - Shift: the same fine move, walking a selection's edge (see
 *    utils/selectionExtend) — the keyboard twin of Shift+click.
 *  - {mod}+Shift: extend straight to the start/end of the track.
 *
 * While playback runs every press is a plain coarse scrub: the ramp seeks each
 * frame (and a seek mid-play restarts the engine), while a selection built
 * around a moving playhead fights the playback it's being drawn over.
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

  type Ramp = { dir: -1 | 1; extend: boolean; raf: number; repeats: number; lastKeyAt: number };
  const rampRef = useRef<Ramp | null>(null);
  const gestureRef = useRef<ExtendGesture | null>(null);
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

  /** Move the playhead alone, leaving any selection where it is. */
  const scrubTo = useCallback((target: number) => {
    cbRef.current.seek(clamp(target, 0, durationRef.current));
  }, [durationRef]);

  /** Walk the current extend gesture's edge to `target`. */
  const extendTo = useCallback((target: number, scrollView = false) => {
    const gesture = extendGestureFor(gestureRef.current, selectionRef.current, currentTimeRef.current);
    const edge = clamp(target, 0, durationRef.current);
    const next = spanBetween(gesture.anchor, edge);
    // Selection first: it updates `selectionRef` synchronously, so a seek made
    // straight after sees the new selection, not the stale one.
    cbRef.current.onSelectionChange(next);
    gestureRef.current = { ...gesture, edge, selection: next };
    dirtyRef.current = true;
    // Only a selection drawn out of the playhead drags it along — and never
    // while the media clock owns it.
    if (gesture.follow && !isPlayingRef.current) cbRef.current.seek(edge, scrollView);
    scheduleSettle();
  }, [selectionRef, currentTimeRef, durationRef, scheduleSettle]);

  /** One step of `px` screen pixels, in whichever mode is running. */
  const movePixels = useCallback((dir: -1 | 1, extend: boolean, px: number) => {
    const pps = Math.max(cbRef.current.getPixelsPerSecond(), 1);
    const delta = dir * (px / pps);
    if (extend) extendTo((gestureRef.current?.edge ?? currentTimeRef.current) + delta);
    else scrubTo(currentTimeRef.current + delta);
  }, [extendTo, scrubTo, currentTimeRef]);

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
    // Each ramp owns its object, and a tick that finds itself displaced stops
    // rescheduling. Without that identity check a tick from a superseded ramp
    // overwrites the live ramp's frame handle, leaving a loop nothing holds a
    // handle to — a playhead that keeps panning after every key is up.
    const ramp: Ramp = { dir, extend, raf: 0, repeats: 0, lastKeyAt: performance.now() };
    const tick = () => {
      if (rampRef.current !== ramp) return;
      const now = performance.now();
      // Watchdog: once the OS has sent a repeat for this key we know repeats
      // are on, so their drying up means the key is up and the keyup went
      // missing (a swallowed event, a lost focus). Never armed when repeats
      // are off — there'd be nothing to miss.
      if (ramp.repeats > 0 && now - ramp.lastKeyAt > KEY_REPEAT_GAP_MS) { stopRamp(); return; }
      const dt = (now - last) / 1000;
      last = now;
      const velocity = rampVelocityPx((now - heldStart) / 1000);
      if (velocity > 0) movePixels(dir, extend, velocity * dt);
      if (rampRef.current === ramp) ramp.raf = requestAnimationFrame(tick);
    };
    rampRef.current = ramp;
    ramp.raf = requestAnimationFrame(tick);
  }, [stopRamp, movePixels]);

  const onArrow = useCallback((e: KeyboardEvent, dir: -1 | 1, extend: boolean) => {
    // Coarse: one 10%-of-window jump per press (including the OS's own key
    // repeats). Used when there's no selection to work against, and for every
    // press while the engine is running.
    if (isPlayingRef.current || (!extend && !selectionRef.current)) {
      stopRamp();
      scrubTo(scrubTarget(currentTimeRef.current, durationRef.current, zoomSecRef.current, dir));
      return;
    }
    const ramp = rampRef.current;
    if (ramp && ramp.dir === dir && ramp.extend === extend) {
      // Already running — the repeat is only evidence the key is still down.
      ramp.repeats += 1;
      ramp.lastKeyAt = performance.now();
      return;
    }
    // OS key repeats are ignored: the ramp, not the repeat rate, sets the pace.
    if (e.repeat && ramp) return;
    startRamp(dir, extend);
  }, [selectionRef, currentTimeRef, durationRef, zoomSecRef, stopRamp, startRamp, scrubTo]);

  useHotkeys([
    { key: 'ArrowLeft', handler: e => onArrow(e, -1, false) },
    { key: 'ArrowRight', handler: e => onArrow(e, 1, false) },
    { key: 'ArrowLeft', mods: ['shift'], handler: e => onArrow(e, -1, true) },
    { key: 'ArrowRight', mods: ['shift'], handler: e => onArrow(e, 1, true) },
    { key: 'ArrowLeft', mods: ['shift', 'mod'], handler: () => { stopRamp(); extendTo(0, true); } },
    { key: 'ArrowRight', mods: ['shift', 'mod'], handler: () => { stopRamp(); extendTo(durationRef.current, true); } },
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
    window.addEventListener('mousedown', stopRamp);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousedown', stopRamp);
      stopRamp();
      settleNow();
    };
  }, [enabled, stopRamp, settleNow]);
}
