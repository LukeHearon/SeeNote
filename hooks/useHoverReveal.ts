import { useCallback, useRef, useState } from 'react';

/**
 * Open-on-hover, close-after-a-grace-delay state. The delay means moving the
 * mouse imprecisely between a trigger and its revealed panel doesn't dismiss
 * it — re-entering either cancels the pending close.
 */
export function useHoverReveal(closeDelayMs = 400) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const onMouseEnter = useCallback(() => { cancelClose(); setOpen(true); }, [cancelClose]);
  const onMouseLeave = useCallback(() => {
    cancelClose();
    timeoutRef.current = setTimeout(() => setOpen(false), closeDelayMs);
  }, [cancelClose, closeDelayMs]);

  return { open, onMouseEnter, onMouseLeave };
}
