import { useEffect, useState } from 'react';

/**
 * `value`, but only once it has held still for `delayMs`.
 *
 * For work too expensive to redo on every keystroke. The find dock is the
 * motivating case: each character re-runs the matcher over every label in the
 * project and rebuilds the result list, and the first two or three characters of
 * a partial or regex query match nearly everything — so the renders nobody asked
 * for are both the biggest and the most numerous.
 *
 * The first value is adopted immediately; there is nothing yet to wait for.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);

  return settled;
}
