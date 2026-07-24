import { useEffect, useState } from 'react';

/**
 * Tracks whether Alt/Option is currently held down, window-wide.
 *
 * Alt is the "annotate without disturbing playback" modifier: while it's down,
 * spectrogram drags create annotations without seeking or changing the selection,
 * and playhead lock is suspended so the view stops chasing the playhead out from
 * under the pointer. Both the Spectrogram and the Toolbar (which pales the lock
 * icon to signal the suspension) read this same hook.
 *
 * Cleared on window blur so alt-tabbing away can't leave it stuck on — the keyup
 * is delivered to the other window, never to us.
 */
export function useAltHeld(): boolean {
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const clear = () => setAltHeld(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', clear);
    };
  }, []);

  return altHeld;
}
