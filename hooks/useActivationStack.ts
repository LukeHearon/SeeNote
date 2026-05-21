import { useState, useCallback, useRef } from 'react';

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
  const stackRef = useRef<ActivationKind[]>(stack);
  stackRef.current = stack;

  const pushIfAbsent = useCallback((kind: ActivationKind) => {
    setStack(prev => (prev.includes(kind) ? prev : [...prev, kind]));
  }, []);

  const remove = useCallback((kind: ActivationKind) => {
    setStack(prev => (prev.includes(kind) ? prev.filter(k => k !== kind) : prev));
  }, []);

  const popTop = useCallback((): ActivationKind | null => {
    const cur = stackRef.current;
    if (cur.length === 0) return null;
    const top = cur[cur.length - 1];
    setStack(cur.slice(0, -1));
    return top;
  }, []);

  const topOf = useCallback((kinds: ActivationKind[]): ActivationKind | null => {
    const cur = stackRef.current;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (kinds.includes(cur[i])) return cur[i];
    }
    return null;
  }, []);

  return { stack, pushIfAbsent, remove, popTop, topOf };
}
