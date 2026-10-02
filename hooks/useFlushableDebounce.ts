import { useCallback, useEffect, useRef } from 'react';
import { registerExitFlusher } from '../utils/exitFlush';

/**
 * A debounce whose pending write is never dropped: it runs on `flush()`,
 * on unmount (back arrow, OS open-with), and when the window closes (see
 * utils/exitFlush.ts). A plain `setTimeout` + clearTimeout cleanup lost the
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
    const unregister = registerExitFlusher(flush);
    return () => {
      unregister();
      flush();
    };
  }, [flush]);

  return { schedule, flush };
}
