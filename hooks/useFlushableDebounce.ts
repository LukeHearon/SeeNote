import { useCallback, useEffect, useRef } from 'react';

// Every live debouncer, so the window-close handler can flush them all.
const live = new Set<() => void>();

/** Run every pending debounced write now (window close). */
export function flushAllDebouncedWrites(): void {
  for (const flush of [...live]) flush();
}

/**
 * A debounce whose pending write is never dropped: it runs on `flush()`,
 * on unmount (back arrow, OS open-with), and via `flushAllDebouncedWrites()`
 * when the window closes. A plain `setTimeout` + clearTimeout cleanup lost the
 * last settle of a burst whenever the user left inside the delay.
 *
 * `schedule` replaces any pending write: pass a closure over the latest values.
 */
export function useFlushableDebounce() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    pending?.();
  }, []);

  const schedule = useCallback((write: () => void, ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = write;
    timerRef.current = setTimeout(flush, ms);
  }, [flush]);

  useEffect(() => {
    live.add(flush);
    return () => {
      live.delete(flush);
      flush();
    };
  }, [flush]);

  return { schedule, flush };
}
