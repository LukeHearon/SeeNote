import { useCallback, useMemo, useState } from 'react';

export type PanelId = 'video' | 'spectrogram' | 'buzzdetect';

export interface PopoutsApi {
  isPopped: (id: PanelId) => boolean;
  popOut: (id: PanelId) => void;
  popIn: (id: PanelId) => void;
}

/**
 * Which panels are popped out into their own window. Not persisted: the
 * windows don't survive a restart, so neither does the arrangement. A panel
 * that doesn't currently exist (video on an audio track, buzzdetect with its
 * panel off) can stay marked here; the layout only honors the mark while the
 * panel is there.
 */
export function usePopouts(): PopoutsApi {
  const [popped, setPopped] = useState<ReadonlySet<PanelId>>(() => new Set());
  const isPopped = useCallback((id: PanelId) => popped.has(id), [popped]);
  const popOut = useCallback((id: PanelId) => setPopped(prev => new Set(prev).add(id)), []);
  const popIn = useCallback((id: PanelId) => setPopped(prev => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  }), []);
  return useMemo(() => ({ isPopped, popOut, popIn }), [isPopped, popOut, popIn]);
}
