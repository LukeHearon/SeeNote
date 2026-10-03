import { useState, useCallback, useMemo, useRef } from 'react';
import type { HotkeyBinding } from './useHotkeys';

/**
 * The kinds of "layers" that can be activated. The activation stack records
 * activation order so that Esc (and other interactions) can unwind layers in
 * most-recently-activated-first order rather than by a fixed priority.
 *
 * - `annotationTool` — an annotation tool (0–9) is readied (`activeToolKey`).
 * - `selection`      — a selection region exists.
 * - `filterTool`     — the band-pass filter tool is readied for drag drawing.
 * - `filterBand`     — a band-pass band has been drawn and filtering is engaged.
 */
export type ActivationKind = 'annotationTool' | 'selection' | 'filterTool' | 'filterBand';

export interface ActivationStackApi {
  /** Live stack value, oldest at index 0, most recent at the end. */
  stack: ActivationKind[];
  /** Append `kind` if absent; if already present, leave its position alone (user is editing the past). */
  pushIfAbsent: (kind: ActivationKind) => void;
  /** Remove `kind` from any position. No-op if absent. */
  remove: (kind: ActivationKind) => void;
  /** Remove and return the topmost (most recent) entry. */
  popTop: () => ActivationKind | null;
  /** Peek the most recent of the given kinds (used for cursor mode). */
  topOf: (kinds: ActivationKind[]) => ActivationKind | null;
}

/**
 * The single source of truth for layer-activation order. State lives here so
 * both AnnotationWindow's hotkey handlers and Spectrogram's drag handlers
 * (via callback props) push/pop the same stack.
 */
export function useActivationStack(): ActivationStackApi {
  const [stack, setStack] = useState<ActivationKind[]>([]);
  // The ref is the source of truth, updated synchronously by every operation,
  // so several in one tick (an Esc pop next to a selection clear) compose
  // instead of each acting on the last rendered value. State mirrors it for
  // rendering.
  const stackRef = useRef<ActivationKind[]>(stack);
  const commit = useCallback((next: ActivationKind[]) => {
    if (next === stackRef.current) return;
    stackRef.current = next;
    setStack(next);
  }, []);

  const pushIfAbsent = useCallback((kind: ActivationKind) => {
    const cur = stackRef.current;
    if (!cur.includes(kind)) commit([...cur, kind]);
  }, [commit]);

  const remove = useCallback((kind: ActivationKind) => {
    const cur = stackRef.current;
    if (cur.includes(kind)) commit(cur.filter(k => k !== kind));
  }, [commit]);

  const popTop = useCallback((): ActivationKind | null => {
    const cur = stackRef.current;
    if (cur.length === 0) return null;
    commit(cur.slice(0, -1));
    return cur[cur.length - 1];
  }, [commit]);

  const topOf = useCallback((kinds: ActivationKind[]): ActivationKind | null => {
    const cur = stackRef.current;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (kinds.includes(cur[i])) return cur[i];
    }
    return null;
  }, []);

  // Stable between stack changes, so callbacks that list the API as a
  // dependency don't churn on every render.
  return useMemo(
    () => ({ stack, pushIfAbsent, remove, popTop, topOf }),
    [stack, pushIfAbsent, remove, popTop, topOf],
  );
}

/**
 * Escape as a universal undo of the most recently activated layer: pops the
 * top of the stack and runs that layer's clear action. Fires even when a text
 * input has focus. A kind with no entry (or an empty stack) is a no-op.
 */
export function escapeUnwindBinding(
  stack: ActivationStackApi,
  clear: Partial<Record<ActivationKind, () => void>>,
): HotkeyBinding {
  return {
    key: 'Escape',
    allowInInput: true,
    handler: () => {
      const top = stack.popTop();
      if (top) clear[top]?.();
    },
  };
}
