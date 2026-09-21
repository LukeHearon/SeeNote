import React from 'react';
import { useHotkeys } from './useHotkeys';
import { Selection } from '../types';
import { SpectrogramHandle } from '../components/Spectrogram';

interface UseSpectrogramZoomHotkeysArgs {
  spectrogramRef: React.RefObject<SpectrogramHandle>;
  durationRef: React.MutableRefObject<number>;
  zoomSecRef: React.MutableRefObject<number>;
  preZoomExtentRef: React.MutableRefObject<{ startTime: number; endTime: number } | null>;
  /** Current visible-window start time, for the mod+0 fit/restore toggle's
   *  "remember where I was" snapshot. Defaults to 0 (start of the visible
   *  window isn't tracked) when the caller has no viewport store to read. */
  getViewportStartTime?: () => number;
  /** Live selection; when set, mod+shift+plus zooms to fill it (with padding). */
  selectionRef?: React.MutableRefObject<Selection | null>;
  /** Mirrors useHotkeys' own `enabled` — false while a modal owns the keyboard. */
  enabled?: boolean;
}

// Fraction of the selection's length added on each side when zooming to it.
const SELECTION_ZOOM_PAD = 0.1;

// mod+=/mod+- : spectrogram zoom in/out. mod+shift+plus zooms to fill the
// active selection (10% padding per side), else behaves like mod+=.
// mod+0: toggle between the current zoom and "fit entire track", remembering
// the pre-fit viewport so a second press restores it. Shared verbatim between
// AnnotationWindow and SingleFileWindow — this used to be hand-copied in both.
export function useSpectrogramZoomHotkeys({
  spectrogramRef,
  durationRef,
  zoomSecRef,
  preZoomExtentRef,
  getViewportStartTime = () => 0,
  selectionRef,
  enabled = true,
}: UseSpectrogramZoomHotkeysArgs): void {
  useHotkeys([
    { key: '=', mods: ['mod'], handler: () => { spectrogramRef.current?.zoomIn(); preZoomExtentRef.current = null; } },
    { key: '+', mods: ['mod', 'shift'], handler: () => {
        const sel = selectionRef?.current;
        if (sel && sel.end > sel.start) {
          const pad = (sel.end - sel.start) * SELECTION_ZOOM_PAD;
          spectrogramRef.current?.zoomToRange(Math.max(0, sel.start - pad), sel.end + pad);
        } else {
          spectrogramRef.current?.zoomIn();
        }
        preZoomExtentRef.current = null;
    }},
    { key: '-', mods: ['mod'], handler: () => { spectrogramRef.current?.zoomOut(); preZoomExtentRef.current = null; } },
    { key: '0', mods: ['mod'], handler: () => {
        const dur = durationRef.current;
        if (!dur) return;
        const startTime = getViewportStartTime();
        const isAtFullExtent = zoomSecRef.current >= dur;
        if (isAtFullExtent && preZoomExtentRef.current) {
          const saved = preZoomExtentRef.current;
          spectrogramRef.current?.zoomToRange(saved.startTime, saved.endTime);
          preZoomExtentRef.current = null;
        } else {
          preZoomExtentRef.current = { startTime, endTime: startTime + zoomSecRef.current };
          spectrogramRef.current?.zoomToRange(0, dur);
        }
    }},
  ], enabled);
}
