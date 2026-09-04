import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Annotation, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter } from '../types';
import { yToFreq } from '../utils/audioProcessing';
import { makeAnnotationFromTool, clamp, updateAnnotation } from '../utils/helpers';
import { xToTime, maxScroll as computeMaxScroll } from '../utils/viewportTransform';
import { shouldPromoteDragIntent } from '../utils/dragIntent';
import type { Timeline } from '../utils/subsetTimeline';
import type { CurrentTimeStore } from '../utils/currentTimeStore';

export interface SpectrogramInteractionParams {
  // Shared geometry refs/values owned by Spectrogram (scroll/zoom/render).
  containerRef: React.RefObject<HTMLDivElement>;
  scrollLeftRef: React.MutableRefObject<number>;
  pixelsPerSecondRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  setScroll: (v: number, source?: string) => void;
  pixelsPerSecond: number;
  duration: number;
  // Display->source map, read live. Under a subset it says where the cuts are,
  // which is what keeps a drag inside one span: two runs that are adjacent on
  // screen aren't adjacent in the file, so a selection or annotation spanning
  // them would name audio the user never saw. Identity when subset is off, and
  // then every clamp below is a no-op.
  timelineRef: React.MutableRefObject<Timeline>;
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
  /** Open (and focus) an annotation's inline label editor. */
  onEditAnnotationText: (id: string) => void;
  onBandPassFilterChange: (f: BandPassFilter | null) => void;
  onBandPassFilterDrawn: (f: BandPassFilter) => void;
  // Cursor-tracking setters (drag triggers no re-render, but mouse-move does).
  setCursorPos: (p: { x: number; y: number } | null) => void;
  setSuppressCustomCursor: (v: boolean) => void;
  // Right-drag pan timestamp (shared with wheel handling).
  lastManualScrollRef: React.MutableRefObject<number>;
  // Fires on a right-click that didn't turn into a pan drag (movement stayed
  // under CONTEXT_MENU_MOVE_THRESHOLD_PX between mousedown and mouseup) — the
  // signal to open a context menu. Right-click always starts a pan drag (see
  // handleMouseDown), so this is how a plain right-click is told apart from one.
  onContextMenu?: (clientX: number, clientY: number) => void;
  // Live Alt state, read at annotation-commit time so toggling Alt mid-drag (after
  // mousedown, before mouseup) can flip whether the new annotation gets highlighted.
  isAltHeldRef: React.MutableRefObject<boolean>;
}

export interface SpectrogramInteractionApi {
  // Interaction state (consumed by overlays / draw).
  creatingAnnotation: { start: number; current: number } | null;
  /** Commit a drawn span (pinned end, dragged end) as an annotation or a selection. */
  commitSpan: (anchor: number, edge: number, quiet?: boolean) => void;
  creatingSelection: { start: number; current: number; quiet?: boolean } | null;
  creatingFilter: { y0: number; y1: number } | null;
  dragStart: { x: number; scroll: number } | null;
  // Refs shared with AnnotationOverlay (prop contract).
  pendingAnnotationsRef: React.MutableRefObject<Annotation[]>;
  clickDownRef: React.MutableRefObject<{ x: number; y: number; annotationId: string; pointerTime: number } | null>;
  playheadFollowsAnnotationStartRef: React.MutableRefObject<boolean>;
  // Annotation handle currently being dragged, if any (drawn by AnnotationResizeLine).
  resizingAnnotation: { id: string; side: 'start' | 'end'; originalTime: number } | null;
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
  pixelsPerSecond,
  duration,
  timelineRef,
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
  onEditAnnotationText,
  onBandPassFilterChange,
  onBandPassFilterDrawn,
  setCursorPos,
  setSuppressCustomCursor,
  lastManualScrollRef,
  isAltHeldRef,
  onContextMenu,
}: SpectrogramInteractionParams): SpectrogramInteractionApi {
  const [dragStart, setDragStart] = useState<{ x: number; scroll: number } | null>(null);
  // Screen position at a right-button mousedown, so mouseup can tell a plain
  // right-click (context menu) apart from a right-drag pan (see onContextMenu).
  const rightClickStartRef = useRef<{ x: number; y: number } | null>(null);
  const CONTEXT_MENU_MOVE_THRESHOLD_PX = 4;

  // Interaction State (annotations — only when activeAnnotationTool !== null)
  const [creatingAnnotation, setCreatingAnnotation] = useState<{ start: number; current: number } | null>(null);
  const [resizingAnnotation, setResizingAnnotation] = useState<{ id: string; side: 'start' | 'end'; originalTime: number } | null>(null);
  const [draggedAnnotation, setDraggedAnnotation] = useState<{ id: string; startOffset: number } | null>(null);

  // Selection Mode interaction state
  const [creatingSelection, setCreatingSelection] = useState<{ start: number; current: number; quiet?: boolean } | null>(null);
  const [resizingSelectionHandle, setResizingSelectionHandle] = useState<'start' | 'end' | null>(null);

  // Filter tool interaction state
  const [creatingFilter, setCreatingFilter] = useState<{ y0: number; y1: number } | null>(null);
  const [resizingFilterEdge, setResizingFilterEdge] = useState<'low' | 'high' | null>(null);

  // Annotation-bound selection state is lifted to App.tsx (boundAnnotationId prop + onBoundAnnotationChange).

  // Track mousedown on annotation center to distinguish click vs drag
  const clickDownRef = useRef<{ x: number; y: number; annotationId: string; pointerTime: number } | null>(null);

  // Pending drag intent: recorded at mousedown but not promoted to visible state until
  // shouldPromoteDragIntent says the pointer has moved far enough or been held long enough.
  // Using refs (not state) so no re-render/gray-out happens until the threshold is crossed.
  const pendingSelectionRef = useRef<{ start: number; startX: number; startTime: number; quiet: boolean } | null>(null);
  const pendingAnnotationRef = useRef<{ start: number; startX: number; startTime: number; quiet: boolean } | null>(null);

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

  // While playing, a newly made selection that doesn't contain the playhead would
  // otherwise leave the two out of sync (audio still coming from the old position
  // while the new range is highlighted) — snap playback to the selection's start.
  // Left alone while paused: a paused seek is the user's to make explicitly.
  const snapPlayheadIfOutside = useCallback((start: number, end: number) => {
    if (!isPlaying) return;
    const t = currentTimeStore.get();
    if (t < start || t > end) onSeek(start);
  }, [isPlaying, currentTimeStore, onSeek]);

  // Shared: create an annotation from the active tool, commit it, and enter annotation-bound selection state.
  // `quiet` (Alt-drag) commits the annotation without selecting it, moving the
  // selection, or touching the playhead, so annotating never disturbs an in-progress listen.
  const commitNewAnnotation = useCallback((start: number, end: number, quiet = false) => {
    if (!activeAnnotationTool) return;
    const newAnnotation = makeAnnotationFromTool(activeAnnotationTool, start, end);
    onAnnotationsCommit([...annotations, newAnnotation]);
    if (quiet) {
      // The Custom tool creates an unnamed annotation, and the only way to name
      // one is its inline editor — which the quiet path never opened, because it
      // mounts off the selection Alt deliberately leaves alone. Open it
      // explicitly instead: typing a label disturbs neither playback nor the
      // selection, so it stays within Alt's promise.
      if (newAnnotation.text === '') onEditAnnotationText(newAnnotation.id);
      return;
    }
    onSelectAnnotation(newAnnotation.id);
    onBoundAnnotationChange(newAnnotation.id);
    onSelectionChange({ start, end });
    snapPlayheadIfOutside(start, end);
  }, [activeAnnotationTool, annotations, onAnnotationsCommit, onSelectAnnotation, onBoundAnnotationChange, onSelectionChange, onEditAnnotationText, snapPlayheadIfOutside]);

  /**
   * Turn a span the user has just drawn out into whatever the current mode
   * makes of it: an annotation when a tool is readied, a selection otherwise.
   * Takes the span as the end it was pinned at and the end it was dragged to,
   * in that order — a span drawn right-to-left passes them the other way round.
   * The one place that decision is made — mouse drags, Shift+click and the
   * keyboard sweep (via SpectrogramHandle.commitSpan) all come through here, so
   * a gesture means the same thing whichever way it was performed.
   *
   * `quiet` is Alt's "don't disturb the listen": the annotation is committed
   * without being selected, bound, or pulling the playhead to it.
   */
  const commitSpan = useCallback((anchor: number, edge: number, quiet = false) => {
    const start = Math.min(anchor, edge);
    const end = Math.max(anchor, edge);
    if (end - start <= 0) {
      if (!quiet) onSelectionChange(null);
      return;
    }
    if (activeAnnotationTool !== null) {
      commitNewAnnotation(start, end, quiet);
      return;
    }
    // `anchor` is kept so a later Shift+arrow carries on from the end the user
    // placed last, even when that's the earlier of the two.
    onSelectionChange({ start, end, anchor });
    onBoundAnnotationChange(null);
    if (!quiet) snapPlayheadIfOutside(start, end);
  }, [activeAnnotationTool, commitNewAnnotation, onSelectionChange, onBoundAnnotationChange, snapPlayheadIfOutside]);

  const getPointerTime = (e: React.MouseEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x, scrollLeftRef.current, pixelsPerSecondRef.current);
    return clamp(t, 0, duration);
  };

  // Every drag is anchored somewhere — where it began, or the edge that isn't
  // moving — and the pointer is held inside that anchor's span, so a gesture
  // can't reach across a subset cut into audio that was never shown. Both drag
  // paths go through this one function: the ref-only one below (RAF/window) and
  // the element's own mousemove handler, which runs last for events over the
  // spectrogram and would otherwise write back an unclamped time.
  // Identity timeline (no subset) → the pointer time, unchanged.
  const holdInSpan = useCallback(
    (anchor: number, t: number) => timelineRef.current.clampToSpanOfDisplay(anchor, t),
    [],
  );

  // Updates drag state using only refs — safe to call from a RAF loop or window handler.
  const processDragAtClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rawT = clamp(
      xToTime(clientX - rect.left, scrollLeftRef.current, pixelsPerSecondRef.current),
      0,
      durationRef.current,
    );
    const held = (anchor: number) => holdInSpan(anchor, rawT);

    const ca = creatingAnnotationRef.current;
    if (ca) { setCreatingAnnotation({ ...ca, current: held(ca.start) }); return; }

    const cs = creatingSelectionRef.current;
    if (cs) {
      const ct = held(cs.start);
      setCreatingSelection({ ...cs, current: ct });
      const liveStart = Math.min(cs.start, ct);
      const liveEnd = Math.max(cs.start, ct);
      onSelectionChangeRef.current({ start: liveStart, end: liveEnd });
      return;
    }

    const ra = resizingAnnotationRef.current;
    if (ra) {
      const updated = updateAnnotation(annotationsRef.current, ra.id, a => {
        // Anchored on the edge that isn't moving.
        if (ra.side === 'start') return { ...a, start: Math.min(held(a.end), a.end - 0.05) };
        return { ...a, end: Math.max(held(a.start), a.start + 0.05) };
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
        // Whole-annotation move: both edges must land in the span it's already
        // in, so the pointer is held there and the far edge clamped too.
        const tl = timelineRef.current;
        const spanEnd = tl.clampToSpanOfDisplay(a.start, durationRef.current);
        const spanStart = tl.clampToSpanOfDisplay(a.start, 0);
        const newStart = clamp(held(a.start) - da.startOffset, spanStart, Math.max(spanStart, spanEnd - dur));
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
      if (rsh === 'start') newStart = Math.min(held(sel.end), sel.end - 0.05);
      else newEnd = Math.max(held(sel.start), sel.start + 0.05);
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
          // Trigger against the app window's edges, not the container's — the container
          // rect is asymmetric (e.g. a sidebar keeps its left edge well inside the window,
          // while its right edge often coincides with the window edge). When the window is
          // flush against the monitor edge the OS clamps the cursor there, so it can never
          // physically overflow rect.right. Pulling the bound in by a margin gives both
          // sides room to trigger before the cursor would need to leave the window.
          const AUTOPAN_EDGE_MARGIN = 24;
          const leftBound = AUTOPAN_EDGE_MARGIN;
          const rightBound = window.innerWidth - AUTOPAN_EDGE_MARGIN;
          if (pos.clientX < leftBound) overflow = pos.clientX - leftBound;       // negative → pan left
          else if (pos.clientX > rightBound) overflow = pos.clientX - rightBound; // positive → pan right
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
            // Runs every tick the pointer is past the edge — not just when the view actually
            // scrolled — because once the view is already pinned at 0/end (no room left to
            // scroll), scrollChanged is false forever, but the annotation must still keep
            // hugging the edge as the mouse continues moving, or it freezes with a gap.
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
      setDragStart({ x: e.clientX, scroll: scrollLeftRef.current });
      rightClickStartRef.current = { x: e.clientX, y: e.clientY };
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

      // Alt/Option: annotate-only mode. Drag out an annotation without seeking the
      // playhead, clearing the selection, or changing what's selected — so you can
      // keep listening while marking the sounds you just heard.
      if (e.altKey) {
        // With a tool armed: quiet annotation drag. With no tool: quiet selection
        // drag — draw out a selection without seeking, clearing, or snapping playback.
        if (activeAnnotationTool === null) {
          pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: true };
        } else {
          pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: true };
        }
        return;
      }

      // Shift+click while paused: extend/create from playhead to click point
      if (e.shiftKey && !isPlaying) {
        // The playhead is the pinned end; the click is the end just placed.
        commitSpan(currentTimeStore.get(), t);
        return;
      }

      // Click inside existing selection: seek, then allow drag to replace it
      if (selection && t >= selection.start && t <= selection.end) {
        onSeek(t);
        if (activeAnnotationTool === null) {
          pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: false };
        } else {
          pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: false };
        }
        return;
      }

      // Click outside selection: clear state, seek, record pending drag intent
      onSelectAnnotation(null);
      onBoundAnnotationChange(null);
      onSelectionChange(null);
      onSeek(t);
      if (activeAnnotationTool === null) {
        pendingSelectionRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: false };
      } else {
        pendingAnnotationRef.current = { start: t, startX: e.clientX, startTime: Date.now(), quiet: false };
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
    const promote = (pending: { startX: number; startTime: number }) => shouldPromoteDragIntent({
      containerWidth,
      startX: pending.startX,
      currentX: e.clientX,
      startTime: pending.startTime,
      now: Date.now(),
    });

    if (pendingAnnotationRef.current) {
      if (promote(pendingAnnotationRef.current)) {
        if (!pendingAnnotationRef.current.quiet) {
          onSelectAnnotation(null);
          onBoundAnnotationChange(null);
          onSelectionChange(null);
        }
        setCreatingAnnotation({ start: pendingAnnotationRef.current.start, current: holdInSpan(pendingAnnotationRef.current.start, t) });
        pendingAnnotationRef.current = null;
      }
      return;
    }

    if (pendingSelectionRef.current) {
      if (promote(pendingSelectionRef.current)) {
        const quiet = pendingSelectionRef.current.quiet;
        if (!quiet) {
          onSelectAnnotation(null);
          onBoundAnnotationChange(null);
          onSelectionChange(null);
        }
        setCreatingSelection({ start: pendingSelectionRef.current.start, current: holdInSpan(pendingSelectionRef.current.start, t), quiet });
        pendingSelectionRef.current = null;
      }
      return;
    }

    if (creatingAnnotation) {
      setCreatingAnnotation({ ...creatingAnnotation, current: holdInSpan(creatingAnnotation.start, t) });
      return;
    }

    if (creatingSelection) {
      const ct = holdInSpan(creatingSelection.start, t);
      setCreatingSelection({ ...creatingSelection, current: ct });
      const liveStart = Math.min(creatingSelection.start, ct);
      const liveEnd = Math.max(creatingSelection.start, ct);
      onSelectionChange({ start: liveStart, end: liveEnd });
      return;
    }

    if (resizingAnnotation) {
      const updated = updateAnnotation(annotations, resizingAnnotation.id, a => {
        // Anchored on the edge that isn't moving.
        if (resizingAnnotation.side === 'start') return { ...a, start: Math.min(holdInSpan(a.end, t), a.end - 0.05) };
        return { ...a, end: Math.max(holdInSpan(a.start, t), a.start + 0.05) };
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
           const desired = holdInSpan(a.start, t) - draggedAnnotation.startOffset;
           // Clamp so neither edge exits the visible viewport (auto-pan handles
           // scrolling) — or the span it's in, so a move can't carry it across a
           // subset cut into audio it was never over.
           const tl = timelineRef.current;
           const spanStart = tl.clampToSpanOfDisplay(a.start, 0);
           const spanEnd = tl.clampToSpanOfDisplay(a.start, durationRef.current);
           const lo = Math.max(0, viewLeft, spanStart);
           const hi = Math.min(durationRef.current - dur, viewRight - dur, spanEnd - dur);
           const newStart = Math.max(lo, Math.min(desired, Math.max(lo, hi)));
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
        newStart = Math.min(holdInSpan(selection.end, t), selection.end - 0.05);
      } else {
        newEnd = Math.max(holdInSpan(selection.start, t), selection.start + 0.05);
      }
      onSelectionChange({
        start: newStart,
        end: newEnd,
        anchor: resizingSelectionHandle === 'start' ? newEnd : newStart,
      });
      // If there's a bound annotation, update its extent to match
      if (boundAnnotationId) {
        const updated = updateAnnotation(annotations, boundAnnotationId, a => ({ ...a, start: newStart, end: newEnd }));
        pendingAnnotationsRef.current = updated;
        onAnnotationsChange(updated);
      }
    }
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    if (dragStart) {
      setDragStart(null);
      const start = rightClickStartRef.current;
      rightClickStartRef.current = null;
      if (start && e) {
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (moved < CONTEXT_MENU_MOVE_THRESHOLD_PX) onContextMenu?.(e.clientX, e.clientY);
      }
    }

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
      // Read Alt live (not the quiet flag captured at mousedown/drag-start) so
      // toggling Alt after the drag began still lands correctly: Alt down by
      // release suppresses the highlight, Alt released by then re-enables it.
      commitSpan(creatingAnnotation.start, creatingAnnotation.current, isAltHeldRef.current);
      setCreatingAnnotation(null);
    }

    if (creatingSelection) {
      // Quiet (Alt) selection: commit the range without pulling playback to it.
      // Read Alt live too, matching the annotation path, so toggling Alt mid-drag lands right.
      commitSpan(creatingSelection.start, creatingSelection.current, isAltHeldRef.current || !!creatingSelection.quiet);
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
    commitSpan,
    creatingSelection,
    creatingFilter,
    dragStart,
    pendingAnnotationsRef,
    clickDownRef,
    playheadFollowsAnnotationStartRef,
    resizingAnnotation,
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
