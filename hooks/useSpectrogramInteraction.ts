import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Annotation, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter } from '../types';
import { yToFreq } from '../utils/audioProcessing';
import { makeAnnotationFromTool, clamp, updateAnnotation } from '../utils/helpers';
import { xToTime, maxScroll as computeMaxScroll } from '../utils/viewportTransform';
import { DRAG_INTENT_HOLD_MS } from '../constants';
import type { CurrentTimeStore } from '../utils/currentTimeStore';

export interface SpectrogramInteractionParams {
  // Shared geometry refs/values owned by Spectrogram (scroll/zoom/render).
  containerRef: React.RefObject<HTMLDivElement>;
  scrollLeftRef: React.MutableRefObject<number>;
  pixelsPerSecondRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  setScroll: (v: number, source?: string) => void;
  scrollLeft: number;
  pixelsPerSecond: number;
  duration: number;
  // Props / callbacks the interaction needs.
  annotations: Annotation[];
  selection: Selection | null;
  boundAnnotationId: string | null;
  activeAnnotationTool: AnnotationTool | null;
  isPlaying: boolean;
  settings: SpectrogramSettings;
  filterToolActive: boolean;
  bandPassFilter: BandPassFilter | null;
  currentTimeStore: CurrentTimeStore;
  onSeek: (time: number) => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onBandPassFilterChange: (f: BandPassFilter | null) => void;
  onBandPassFilterDrawn: (f: BandPassFilter) => void;
  // Cursor-tracking setters (drag triggers no re-render, but mouse-move does).
  setCursorPos: (p: { x: number; y: number } | null) => void;
  setSuppressCustomCursor: (v: boolean) => void;
  // Right-drag pan timestamp (shared with wheel handling).
  lastManualScrollRef: React.MutableRefObject<number>;
}

export interface SpectrogramInteractionApi {
  // Interaction state (consumed by overlays / draw).
  creatingAnnotation: { start: number; current: number } | null;
  creatingSelection: { start: number; current: number } | null;
  creatingFilter: { y0: number; y1: number } | null;
  dragStart: { x: number; scroll: number } | null;
  // Refs shared with AnnotationOverlay (prop contract).
  pendingAnnotationsRef: React.MutableRefObject<Annotation[]>;
  clickDownRef: React.MutableRefObject<{ x: number; y: number; annotationId: string; pointerTime: number } | null>;
  playheadFollowsAnnotationStartRef: React.MutableRefObject<boolean>;
  // State setters exposed to overlays.
  setResizingAnnotation: (v: { id: string; side: 'start' | 'end'; originalTime: number } | null) => void;
  setResizingSelectionHandle: (v: 'start' | 'end' | null) => void;
  setResizingFilterEdge: (v: 'low' | 'high' | null) => void;
  // Handlers wired onto the container.
  getPointerTime: (e: React.MouseEvent) => number;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: (e?: React.MouseEvent) => void;
  // Drag-active flag refs used in onMouseLeave guard.
  isAnyDragActiveRef: React.MutableRefObject<boolean>;
}

/**
 * Owns the spectrogram's pointer-interaction core: annotation create/resize/drag,
 * selection create/resize, band-pass filter create/resize, click-vs-drag
 * detection, the pending drag-intent refs, the out-of-bounds auto-pan rAF loop,
 * and the window-level mouseup / mousemove handlers.
 *
 * Pure extraction from Spectrogram.tsx — no behavior, logic, or timing change.
 * The ~mirror refs (creating/resizing/dragged + annotations/selection/bound +
 * the onChange callback refs) exist to defeat stale closures in the auto-pan
 * loop and window-level handlers, and are kept synced every render exactly as
 * before. Shared geometry refs (scrollLeftRef/pixelsPerSecondRef/durationRef)
 * and `setScroll` are passed in because the scroll/zoom/render path also owns
 * them; this hook only reads/writes through them.
 */
export function useSpectrogramInteraction({
  containerRef,
  scrollLeftRef,
  pixelsPerSecondRef,
  durationRef,
  setScroll,
  scrollLeft,
  pixelsPerSecond,
  duration,
  annotations,
  selection,
  boundAnnotationId,
  activeAnnotationTool,
  isPlaying,
  settings,
  filterToolActive,
  bandPassFilter,
  currentTimeStore,
  onSeek,
  onAnnotationsChange,
  onAnnotationsCommit,
  onSelectAnnotation,
  onSelectionChange,
  onBoundAnnotationChange,
  onBandPassFilterChange,
  onBandPassFilterDrawn,
  setCursorPos,
  setSuppressCustomCursor,
  lastManualScrollRef,
}: SpectrogramInteractionParams): SpectrogramInteractionApi {
  const [dragStart, setDragStart] = useState<{ x: number; scroll: number } | null>(null);

  // Interaction State (annotations — only when activeAnnotationTool !== null)
  const [creatingAnnotation, setCreatingAnnotation] = useState<{ start: number; current: number } | null>(null);
  const [resizingAnnotation, setResizingAnnotation] = useState<{ id: string; side: 'start' | 'end'; originalTime: number } | null>(null);
  const [draggedAnnotation, setDraggedAnnotation] = useState<{ id: string; startOffset: number } | null>(null);

  // Selection Mode interaction state
  const [creatingSelection, setCreatingSelection] = useState<{ start: number; current: number } | null>(null);
  const [resizingSelectionHandle, setResizingSelectionHandle] = useState<'start' | 'end' | null>(null);

  // Filter tool interaction state
  const [creatingFilter, setCreatingFilter] = useState<{ y0: number; y1: number } | null>(null);
  const [resizingFilterEdge, setResizingFilterEdge] = useState<'low' | 'high' | null>(null);

  // Annotation-bound selection state is lifted to App.tsx (boundAnnotationId prop + onBoundAnnotationChange).

  // Track mousedown on annotation center to distinguish click vs drag
  const clickDownRef = useRef<{ x: number; y: number; annotationId: string; pointerTime: number } | null>(null);

  // Pending drag intent: recorded at mousedown but not promoted to visible state until
  // the pointer has moved ≥1% of the canvas width OR been held ≥DRAG_INTENT_HOLD_MS.
  // Using refs (not state) so no re-render/gray-out happens until the threshold is crossed.
  const pendingSelectionRef = useRef<{ start: number; startX: number; startTime: number } | null>(null);
  const pendingAnnotationRef = useRef<{ start: number; startX: number; startTime: number } | null>(null);

  const pendingAnnotationsRef = useRef<Annotation[]>(annotations);

  // Refs for out-of-bounds drag handling (auto-pan + window-level events)
  // These mirror state/props so the RAF loop can read them without stale closures.
  const creatingSelectionRef = useRef(creatingSelection);
  const creatingAnnotationRef = useRef(creatingAnnotation);
  const resizingAnnotationRef = useRef(resizingAnnotation);
  const draggedAnnotationRef = useRef(draggedAnnotation);
  const resizingSelectionHandleRef = useRef(resizingSelectionHandle);
  const annotationsRef = useRef(annotations);
  const boundAnnotationIdRef = useRef(boundAnnotationId);
  const selectionRef = useRef(selection);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onAnnotationsChangeRef = useRef(onAnnotationsChange);
  const mousePosRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // Set to true at drag/resize initiation when the playhead is within 0.5s of
  // the annotation start, so the playhead follows the start for the whole gesture.
  const playheadFollowsAnnotationStartRef = useRef(false);
  const autoPanRafRef = useRef<number | null>(null);
  // Wall-clock (ms) when the pointer first crossed the viewport edge during the current
  // drag. Drives time-based auto-pan acceleration so a fully-zoomed view — where the cursor
  // can only sit barely outside the extent — still ramps up instead of crawling. Reset to
  // null whenever the pointer returns inside or a new drag begins.
  const autoPanAccelStartRef = useRef<number | null>(null);

  // Keep refs in sync so RAF/window handlers read current values without stale closures.
  creatingSelectionRef.current = creatingSelection;
  creatingAnnotationRef.current = creatingAnnotation;
  resizingAnnotationRef.current = resizingAnnotation;
  draggedAnnotationRef.current = draggedAnnotation;
  resizingSelectionHandleRef.current = resizingSelectionHandle;
  annotationsRef.current = annotations;
  boundAnnotationIdRef.current = boundAnnotationId;
  selectionRef.current = selection;
  onSelectionChangeRef.current = onSelectionChange;
  onAnnotationsChangeRef.current = onAnnotationsChange;

  // --- Interaction Handlers ---

  // Shared: create an annotation from the active tool, commit it, and enter annotation-bound selection state.
  const commitNewAnnotation = useCallback((start: number, end: number) => {
    if (!activeAnnotationTool) return;
    const newAnnotation = makeAnnotationFromTool(activeAnnotationTool, start, end);
    onAnnotationsCommit([...annotations, newAnnotation]);
    onSelectAnnotation(newAnnotation.id);
    onBoundAnnotationChange(newAnnotation.id);
    onSelectionChange({ start, end });
  }, [activeAnnotationTool, annotations, onAnnotationsCommit, onSelectAnnotation, onBoundAnnotationChange, onSelectionChange]);

  const getPointerTime = (e: React.MouseEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x, scrollLeft, pixelsPerSecond);
    return clamp(t, 0, duration);
  };

  // Updates drag state using only refs — safe to call from a RAF loop or window handler.
  const processDragAtClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const t = clamp(
      xToTime(clientX - rect.left, scrollLeftRef.current, pixelsPerSecondRef.current),
      0,
      durationRef.current,
    );

    const ca = creatingAnnotationRef.current;
    if (ca) { setCreatingAnnotation({ ...ca, current: t }); return; }

    const cs = creatingSelectionRef.current;
    if (cs) {
      setCreatingSelection({ ...cs, current: t });
      const liveStart = Math.min(cs.start, t);
      const liveEnd = Math.max(cs.start, t);
      onSelectionChangeRef.current({ start: liveStart, end: liveEnd });
      return;
    }

    const ra = resizingAnnotationRef.current;
    if (ra) {
      const updated = updateAnnotation(annotationsRef.current, ra.id, a => {
        if (ra.side === 'start') return { ...a, start: Math.min(t, a.end - 0.05) };
        return { ...a, end: Math.max(t, a.start + 0.05) };
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChangeRef.current(updated);
      if (ra.id === boundAnnotationIdRef.current) {
        const updated2 = updated.find(a => a.id === ra.id);
        if (updated2) onSelectionChangeRef.current({ start: updated2.start, end: updated2.end });
      }
      return;
    }

    const da = draggedAnnotationRef.current;
    if (da) {
      const updated = updateAnnotation(annotationsRef.current, da.id, a => {
        const dur = a.end - a.start;
        const newStart = clamp(t - da.startOffset, 0, durationRef.current - dur);
        return { ...a, start: newStart, end: newStart + dur };
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChangeRef.current(updated);
      return;
    }

    const rsh = resizingSelectionHandleRef.current;
    const sel = selectionRef.current;
    if (rsh && sel) {
      let newStart = sel.start;
      let newEnd = sel.end;
      if (rsh === 'start') newStart = Math.min(t, sel.end - 0.05);
      else newEnd = Math.max(t, sel.start + 0.05);
      onSelectionChangeRef.current({ start: newStart, end: newEnd });
      if (boundAnnotationIdRef.current) {
        const updated = updateAnnotation(annotationsRef.current, boundAnnotationIdRef.current, a => ({ ...a, start: newStart, end: newEnd }));
        pendingAnnotationsRef.current = updated;
        onAnnotationsChangeRef.current(updated);
      }
    }
  }, []); // reads only from refs — stable

  // Whether any selection/annotation drag is currently active
  const isAnyDragActive =
    creatingSelection !== null || creatingAnnotation !== null ||
    resizingAnnotation !== null || draggedAnnotation !== null ||
    resizingSelectionHandle !== null;

  // Keep a ref so window handlers can check without a stale closure
  const isAnyDragActiveRef = useRef(isAnyDragActive);
  isAnyDragActiveRef.current = isAnyDragActive;

  // Filter drags are vertical only — kept out of isAnyDragActive so they don't trigger
  // the horizontal auto-pan, but still tracked for the window-level mouseup handler.
  const isFilterDragActive = creatingFilter !== null || resizingFilterEdge !== null;
  const isFilterDragActiveRef = useRef(isFilterDragActive);
  isFilterDragActiveRef.current = isFilterDragActive;

  // Always track mouse position so the RAF can use it even when mouse is outside the spectrogram
  useEffect(() => {
    const trackMouse = (e: MouseEvent) => { mousePosRef.current = { clientX: e.clientX, clientY: e.clientY }; };
    window.addEventListener('mousemove', trackMouse, { passive: true });
    return () => window.removeEventListener('mousemove', trackMouse);
  }, []);

  // While a filter drag is active, track mouse moves at window level so the drag
  // continues even if the pointer leaves the spectrogram container vertically.
  useEffect(() => {
    if (!isFilterDragActive) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const canvasHeight = container.clientHeight;
      const localY = clamp(e.clientY - rect.top, 0, canvasHeight);

      if (resizingFilterEdge !== null && bandPassFilter) {
        const freq = yToFreq(localY, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        if (resizingFilterEdge === 'low') {
          const newLow = Math.min(freq, bandPassFilter.high - 1);
          onBandPassFilterChange({ ...bandPassFilter, low: Math.max(settings.minFreq, newLow) });
        } else {
          const newHigh = Math.max(freq, bandPassFilter.low + 1);
          onBandPassFilterChange({ ...bandPassFilter, high: Math.min(settings.maxFreq, newHigh) });
        }
      } else if (creatingFilter !== null) {
        setCreatingFilter({ ...creatingFilter, y1: localY });
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isFilterDragActive, creatingFilter, resizingFilterEdge, bandPassFilter, settings.minFreq, settings.maxFreq, settings.frequencyScale, onBandPassFilterChange]);

  // Re-sync pendingAnnotationsRef when the annotations prop changes externally (e.g. undo/redo).
  // If a drag is in flight, discard any pending edit — the undo intentionally rewinds state.
  useEffect(() => {
    if (!isAnyDragActive) {
      pendingAnnotationsRef.current = annotations;
    }
  }, [annotations, isAnyDragActive]);

  // Prevent text selection in all panels while a drag is in progress
  useEffect(() => {
    if (!isAnyDragActive) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => { document.body.style.userSelect = prev; };
  }, [isAnyDragActive]);

  // Auto-pan: while a drag is active and the mouse is outside the spectrogram bounds,
  // scroll the view and update the drag endpoint based on mouse overflow distance.
  useEffect(() => {
    if (!isAnyDragActive) return;

    const tick = () => {
      const pos = mousePosRef.current;
      const container = containerRef.current;
      if (pos && container) {
        const rect = container.getBoundingClientRect();
        const containerWidth = rect.width;
        const pps = pixelsPerSecondRef.current;
        const dur = durationRef.current;
        let overflow = 0;

        const da = draggedAnnotationRef.current;
        if (da) {
          // For annotation drags, trigger auto-pan based on where the annotation edge
          // would land given the current mouse position — not where the mouse itself is.
          // This way panning starts the moment the annotation boundary reaches the viewport
          // edge, even while the mouse is still inside.
          const ann = annotationsRef.current.find(a => a.id === da.id);
          if (ann) {
            const annotDur = ann.end - ann.start;
            const mouseRelX = pos.clientX - rect.left;
            const desiredStartPx = mouseRelX - da.startOffset * pps;
            const desiredEndPx = mouseRelX + (annotDur - da.startOffset) * pps;
            if (desiredStartPx < 0) overflow = desiredStartPx;
            else if (desiredEndPx > containerWidth) overflow = desiredEndPx - containerWidth;
          }
        } else {
          if (pos.clientX < rect.left) overflow = pos.clientX - rect.left;       // negative → pan left
          else if (pos.clientX > rect.right) overflow = pos.clientX - rect.right; // positive → pan right
        }

        if (overflow !== 0) {
          const absOverflow = Math.abs(overflow);
          // Two acceleration terms combine:
          //  1) Overflow-based — the further the pointer is past the edge, the faster (legacy feel).
          //  2) Time-based — the longer the pointer stays past the edge, the faster. This is what
          //     rescues the fully-zoomed case: when the cursor can only sit barely outside the
          //     extent, the overflow term alone crawls, so the time ramp takes over.
          if (autoPanAccelStartRef.current === null) autoPanAccelStartRef.current = performance.now();
          const heldSec = (performance.now() - autoPanAccelStartRef.current) / 1000;
          const timeAccel = Math.min(1 + heldSec * heldSec * 2, 18); // 1×→18× over ~2.9s held
          // Floor the overflow term so a tiny overflow still moves, then scale by the time ramp
          // and clamp the result so panning never becomes uncontrollable.
          const baseSpeed = Math.max(Math.min(Math.pow(absOverflow / 40, 1.5), 40), 0.8);
          const speed = Math.sign(overflow) * Math.min(baseSpeed * timeAccel, 60);
          const maxScroll = computeMaxScroll(dur, pps, containerWidth);
          const newScroll = clamp(scrollLeftRef.current + speed, 0, maxScroll);
          const scrollChanged = Math.abs(newScroll - scrollLeftRef.current) > 0.01;
          if (scrollChanged) setScroll(newScroll, 'dragEdge');

          const da2 = draggedAnnotationRef.current;
          if (da2) {
            // Pin the appropriate boundary to the visible edge so the annotation
            // stays fully visible: start→left edge when panning left, end→right edge when panning right.
            // Only meaningful when the view actually moved.
            if (scrollChanged) {
              const viewLeft = newScroll / pps;
              const viewRight = (newScroll + containerWidth) / pps;
              const updated = updateAnnotation(annotationsRef.current, da2.id, a => {
                const annotDur = a.end - a.start;
                const newStart = overflow < 0
                  ? Math.max(0, viewLeft)
                  : Math.max(0, Math.min(viewRight - annotDur, dur - annotDur));
                return { ...a, start: newStart, end: newStart + annotDur };
              });
              pendingAnnotationsRef.current = updated;
              onAnnotationsChangeRef.current(updated);
              if (da2.id === boundAnnotationIdRef.current) {
                const moved = updated.find(a => a.id === da2.id);
                if (moved) onSelectionChangeRef.current({ start: moved.start, end: moved.end });
              }
            }
          } else {
            // Always drive the drag endpoint from the (clamped) pointer position while it's
            // outside the panel — even when the view is already pinned at 0/end and can't scroll
            // further. Otherwise the selection freezes at the last in-panel sample instead of
            // reaching the extent the pointer is past.
            processDragAtClientX(pos.clientX);
          }
        } else {
          // Pointer is back inside the viewport — reset the time-based pan ramp.
          autoPanAccelStartRef.current = null;
        }
      }
      autoPanRafRef.current = requestAnimationFrame(tick);
    };

    autoPanAccelStartRef.current = null;
    autoPanRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (autoPanRafRef.current) { cancelAnimationFrame(autoPanRafRef.current); autoPanRafRef.current = null; }
    };
  }, [isAnyDragActive, processDragAtClientX]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      setDragStart({ x: e.clientX, scroll: scrollLeft });
      return;
    }

    if ((e.target as HTMLElement).closest('input') || (e.target as HTMLElement).closest('button')) return;

    if (filterToolActive) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const y = e.clientY - rect.top;
      setCreatingFilter({ y0: y, y1: y });
      return;
    }

    const annotationItem = (e.target as HTMLElement).closest('.annotation-item');
    if (!annotationItem) {
      // Clicking bare spectrogram
      const t = getPointerTime(e);

      // Shift+click while paused: extend/create from playhead to click point
      if (e.shiftKey && !isPlaying) {
        const playT = currentTimeStore.get();
        const selStart = Math.min(playT, t);
        const selEnd = Math.max(playT, t);
        if (selEnd - selStart > 0.001) {
          if (activeAnnotationTool === null) {
            onSelectionChange({ start: selStart, end: selEnd });
          } else {
            commitNewAnnotation(selStart, selEnd);
          }
        }
        return;
      }

      // Click inside existing selection: seek, then allow drag to replace it
      if (selection && t >= selection.start && t <= selection.end) {
        onSeek(t);
        if (activeAnnotationTool === null) {
          pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
        } else {
          pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
        }
        return;
      }

      // Click outside selection: clear state, seek, record pending drag intent
      onSelectAnnotation(null);
      onBoundAnnotationChange(null);
      onSelectionChange(null);
      onSeek(t);
      if (activeAnnotationTool === null) {
        pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
      } else {
        pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now() };
      }
    }
    // Annotation center clicks are handled in the annotation onMouseDown handler
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    mousePosRef.current = { clientX: e.clientX, clientY: e.clientY };
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const computedCursor = elUnder ? window.getComputedStyle(elUnder).cursor : 'none';
    setSuppressCustomCursor(computedCursor !== 'none');

    if (dragStart) {
      const delta = dragStart.x - e.clientX;
      const containerWidth = containerRef.current?.clientWidth || 0;
      const maxScroll = computeMaxScroll(duration, pixelsPerSecond, containerWidth);
      lastManualScrollRef.current = Date.now();
      setScroll(clamp(dragStart.scroll + delta, 0, maxScroll), 'rightDragPan');
      return;
    }

    if (resizingFilterEdge !== null && bandPassFilter) {
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const rectY = containerRef.current?.getBoundingClientRect().top ?? 0;
      const localY = clamp(e.clientY - rectY, 0, canvasHeight);
      const freq = yToFreq(localY, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
      if (resizingFilterEdge === 'low') {
        const newLow = Math.min(freq, bandPassFilter.high - 1);
        onBandPassFilterChange({ ...bandPassFilter, low: Math.max(settings.minFreq, newLow) });
      } else {
        const newHigh = Math.max(freq, bandPassFilter.low + 1);
        onBandPassFilterChange({ ...bandPassFilter, high: Math.min(settings.maxFreq, newHigh) });
      }
      return;
    }

    if (creatingFilter !== null) {
      const rectY = containerRef.current?.getBoundingClientRect().top ?? 0;
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const y = clamp(e.clientY - rectY, 0, canvasHeight);
      setCreatingFilter({ ...creatingFilter, y1: y });
      return;
    }

    const t = getPointerTime(e);

    // Check if we should convert a pending annotation click into a drag
    if (clickDownRef.current) {
      const dx = e.clientX - clickDownRef.current.x;
      const dy = e.clientY - clickDownRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 5) {
        // Convert to drag
        const dragAnnotation = annotations.find(a => a.id === clickDownRef.current!.annotationId);
        if (dragAnnotation) {
          setDraggedAnnotation({ id: clickDownRef.current.annotationId, startOffset: clickDownRef.current.pointerTime - dragAnnotation.start });
          playheadFollowsAnnotationStartRef.current =
            Math.abs(currentTimeStore.get() - dragAnnotation.start) <= 0.5;
        }
        clickDownRef.current = null;
      }
      return;
    }

    // Promote pending drag intents once the pointer has moved far enough or been held long enough
    const containerWidth = containerRef.current?.clientWidth || 0;
    const thresholdPx = containerWidth * 0.01;

    if (pendingAnnotationRef.current) {
      const dx = Math.abs(e.clientX - pendingAnnotationRef.current.startX);
      const heldMs = Date.now() - pendingAnnotationRef.current.startTime;
      if (dx >= thresholdPx || heldMs >= DRAG_INTENT_HOLD_MS) {
        onSelectAnnotation(null);
        onBoundAnnotationChange(null);
        onSelectionChange(null);
        setCreatingAnnotation({ start: pendingAnnotationRef.current.start, current: t });
        pendingAnnotationRef.current = null;
      }
      return;
    }

    if (pendingSelectionRef.current) {
      const dx = Math.abs(e.clientX - pendingSelectionRef.current.startX);
      const heldMs = Date.now() - pendingSelectionRef.current.startTime;
      if (dx >= thresholdPx || heldMs >= DRAG_INTENT_HOLD_MS) {
        onSelectAnnotation(null);
        onBoundAnnotationChange(null);
        onSelectionChange(null);
        setCreatingSelection({ start: pendingSelectionRef.current.start, current: t });
        pendingSelectionRef.current = null;
      }
      return;
    }

    if (creatingAnnotation) {
      setCreatingAnnotation({ ...creatingAnnotation, current: t });
      return;
    }

    if (creatingSelection) {
      setCreatingSelection({ ...creatingSelection, current: t });
      const liveStart = Math.min(creatingSelection.start, t);
      const liveEnd = Math.max(creatingSelection.start, t);
      onSelectionChange({ start: liveStart, end: liveEnd });
      return;
    }

    if (resizingAnnotation) {
      const updated = updateAnnotation(annotations, resizingAnnotation.id, a => {
        if (resizingAnnotation.side === 'start') return { ...a, start: Math.min(t, a.end - 0.05) };
        return { ...a, end: Math.max(t, a.start + 0.05) };
      });
      pendingAnnotationsRef.current = updated;
      onAnnotationsChange(updated);
      const updatedAnnotation = updated.find(a => a.id === resizingAnnotation.id);
      if (updatedAnnotation) {
        if (resizingAnnotation.id === boundAnnotationId) onSelectionChange({ start: updatedAnnotation.start, end: updatedAnnotation.end });
        if (playheadFollowsAnnotationStartRef.current && resizingAnnotation.side === 'start') onSeek(updatedAnnotation.start);
      }
      return;
    }

    if (draggedAnnotation) {
       const pps = pixelsPerSecondRef.current;
       const viewLeft = scrollLeftRef.current / pps;
       const viewRight = (scrollLeftRef.current + (containerRef.current?.clientWidth ?? 0)) / pps;
       const updated = updateAnnotation(annotations, draggedAnnotation.id, a => {
           const dur = a.end - a.start;
           const desired = t - draggedAnnotation.startOffset;
           // Clamp so neither edge exits the visible viewport (auto-pan handles scrolling).
           const newStart = Math.max(0, Math.max(viewLeft, Math.min(desired, Math.min(durationRef.current - dur, viewRight - dur))));
           return { ...a, start: newStart, end: newStart + dur };
       });
       pendingAnnotationsRef.current = updated;
       onAnnotationsChange(updated);
       const moved = updated.find(a => a.id === draggedAnnotation.id);
       if (moved) {
         if (boundAnnotationId === draggedAnnotation.id) onSelectionChange({ start: moved.start, end: moved.end });
         if (playheadFollowsAnnotationStartRef.current) onSeek(moved.start);
       }
       return;
    }

    if (resizingSelectionHandle && selection) {
      let newStart = selection.start;
      let newEnd = selection.end;
      if (resizingSelectionHandle === 'start') {
        newStart = Math.min(t, selection.end - 0.05);
      } else {
        newEnd = Math.max(t, selection.start + 0.05);
      }
      onSelectionChange({ start: newStart, end: newEnd });
      // If there's a bound annotation, update its extent to match
      if (boundAnnotationId) {
        const updated = updateAnnotation(annotations, boundAnnotationId, a => ({ ...a, start: newStart, end: newEnd }));
        pendingAnnotationsRef.current = updated;
        onAnnotationsChange(updated);
      }
    }
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    if (dragStart) setDragStart(null);

    if (resizingFilterEdge !== null) {
      setResizingFilterEdge(null);
      return;
    }

    if (creatingFilter !== null) {
      const canvasHeight = containerRef.current?.clientHeight ?? 0;
      const yTop = Math.min(creatingFilter.y0, creatingFilter.y1);
      const yBottom = Math.max(creatingFilter.y0, creatingFilter.y1);
      if (yBottom - yTop > 5 && canvasHeight > 0) {
        const high = yToFreq(yTop, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        const low = yToFreq(yBottom, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        // Fresh drag → auto-engage filtering and push the `filterBand` stack
        // entry. Pure edit-in-place geometry (cutoff resize) still uses
        // onBandPassFilterChange and does NOT touch the stack.
        onBandPassFilterDrawn({ low, high, strength: bandPassFilter?.strength ?? 1 });
      }
      setCreatingFilter(null);
      return;
    }

    // Pending annotation click (no significant movement) → annotation-bound selection
    if (clickDownRef.current) {
      const annotation = annotations.find(a => a.id === clickDownRef.current!.annotationId);
      if (annotation) {
        onBoundAnnotationChange(annotation.id);
        onSelectionChange({ start: annotation.start, end: annotation.end });
        onSelectAnnotation(annotation.id);
      }
      clickDownRef.current = null;
    }

    // If the drag never crossed the threshold, discard the pending intent (treat as plain click)
    pendingAnnotationRef.current = null;
    pendingSelectionRef.current = null;

    if (creatingAnnotation) {
      const start = Math.min(creatingAnnotation.start, creatingAnnotation.current);
      const end = Math.max(creatingAnnotation.start, creatingAnnotation.current);
      if (end > start && activeAnnotationTool !== null) {
        commitNewAnnotation(start, end);
      }
      setCreatingAnnotation(null);
    }

    if (creatingSelection) {
      const start = Math.min(creatingSelection.start, creatingSelection.current);
      const end = Math.max(creatingSelection.start, creatingSelection.current);
      if (end > start) {
        onSelectionChange({ start, end });
        onBoundAnnotationChange(null);
      } else {
        onSelectionChange(null);
      }
      setCreatingSelection(null);
    }

    if (resizingAnnotation) {
      onAnnotationsCommit(pendingAnnotationsRef.current);
      setResizingAnnotation(null);
      playheadFollowsAnnotationStartRef.current = false;
    }

    if (draggedAnnotation) {
      onAnnotationsCommit(pendingAnnotationsRef.current);
      setDraggedAnnotation(null);
      playheadFollowsAnnotationStartRef.current = false;
    }

    if (resizingSelectionHandle) {
      if (boundAnnotationId && pendingAnnotationsRef.current.length > 0) {
        onAnnotationsCommit(pendingAnnotationsRef.current);
      }
      setResizingSelectionHandle(null);
    }
  };

  // Handle mouseup outside the spectrogram (e.g. mouse released over another panel).
  // handleMouseUpRef is reassigned to the latest handleMouseUp on every render, so the
  // window-level handler always sees the most recent state — no stale-closure risk.
  const handleMouseUpRef = useRef(handleMouseUp);
  handleMouseUpRef.current = handleMouseUp;
  useEffect(() => {
    const onWindowMouseUp = () => {
      if (isAnyDragActiveRef.current || isFilterDragActiveRef.current) handleMouseUpRef.current();
    };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => window.removeEventListener('mouseup', onWindowMouseUp);
  }, []);

  return {
    creatingAnnotation,
    creatingSelection,
    creatingFilter,
    dragStart,
    pendingAnnotationsRef,
    clickDownRef,
    playheadFollowsAnnotationStartRef,
    setResizingAnnotation,
    setResizingSelectionHandle,
    setResizingFilterEdge,
    getPointerTime,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    isAnyDragActiveRef,
  };
}
