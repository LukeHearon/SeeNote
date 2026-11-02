import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Annotation, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter } from '../types';
import { yToFreq } from '../utils/audioProcessing';
import { makeAnnotationFromTool, clamp, updateAnnotation } from '../utils/helpers';
import { xToTime, maxScroll as computeMaxScroll } from '../utils/viewportTransform';
import { shouldPromoteDragIntent } from '../utils/dragIntent';
import type { Timeline } from '../utils/subsetTimeline';
import { annotationsInBox, type MarqueeBox } from '../utils/multiAnnotationEdit';
import type { AnnotationWithLayer } from '../types';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import { addWindowListener, forEachWindow } from '../utils/windowRegistry';
import { MIN_ANNOTATION_SEC, deltaRange, clampSharedDelta, shiftAnnotations } from '../utils/multiAnnotationEdit';

// Lowest cutoff the band-pass filter graph will honour (see BandPassFilterGraph).
const FILTER_FLOOR_HZ = 20;

/**
 * Map a pointer Y (client coords) to a new cutoff for one edge of the band-pass
 * filter. Dragging past the top of the spectrogram snaps the high cutoff to the
 * file's Nyquist; dragging past the bottom snaps the low cutoff to the filter
 * floor — so the filterable range isn't trapped inside the visible frequency
 * window. Shared by both filter-resize handlers (window-level + in-container).
 */
function resizeFilterEdge(
  edge: 'low' | 'high',
  clientY: number,
  rectTop: number,
  canvasHeight: number,
  filter: BandPassFilter,
  settings: SpectrogramSettings,
  nyquist: number,
): BandPassFilter {
  const rawY = clientY - rectTop;
  const localY = clamp(rawY, 0, canvasHeight);
  let freq = yToFreq(localY, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
  if (rawY <= 0) freq = nyquist;
  else if (rawY >= canvasHeight) freq = FILTER_FLOOR_HZ;
  if (edge === 'low') {
    return { ...filter, low: clamp(Math.min(freq, filter.high - 1), FILTER_FLOOR_HZ, nyquist) };
  }
  return { ...filter, high: clamp(Math.max(freq, filter.low + 1), FILTER_FLOOR_HZ, nyquist) };
}

export interface SpectrogramInteractionParams {
  // Shared geometry refs/values owned by Spectrogram (scroll/zoom/render).
  containerRef: React.RefObject<HTMLDivElement>;
  scrollLeftRef: React.MutableRefObject<number>;
  pixelsPerSecondRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  setScroll: (v: number, source?: string) => void;
  // Display->source map, read live. Under a subset it says where the cuts are,
  // which is what keeps a drag inside one span: two runs that are adjacent on
  // screen aren't adjacent in the file, so a selection or annotation spanning
  // them would name audio the user never saw. Identity when subset is off, and
  // then every clamp below is a no-op.
  timelineRef: React.MutableRefObject<Timeline>;
  // Props / callbacks the interaction needs.
  annotations: Annotation[];
  /** The same annotations with their stacking layer — where each box sits vertically, for the marquee. */
  layeredAnnotationsRef: React.MutableRefObject<AnnotationWithLayer[]>;
  selection: Selection | null;
  boundAnnotationId: string | null;
  /** Annotations Shift-selected together (two or more, else empty). Dragging or
   *  resizing any one of them moves the whole set. */
  multiSelectedIds: readonly string[];
  activeAnnotationTool: AnnotationTool | null;
  isPlaying: boolean;
  settings: SpectrogramSettings;
  /** File sample rate — sampleRate/2 is the highest cutoff the filter can reach. */
  sampleRate: number;
  filterToolActive: boolean;
  bandPassFilter: BandPassFilter | null;
  currentTimeStore: CurrentTimeStore;
  onSeek: (time: number) => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  /** A right-drag box closed over these annotations (none, one, or several). */
  onMarqueeSelect: (ids: string[]) => void;
  /** Open (and focus) an annotation's inline label editor. */
  onEditAnnotationText: (id: string) => void;
  onBandPassFilterChange: (f: BandPassFilter | null) => void;
  onBandPassFilterDrawn: (f: BandPassFilter) => void;
  // Fires on a right-click that didn't turn into a marquee drag (movement stayed
  // under CONTEXT_MENU_MOVE_THRESHOLD_PX between mousedown and mouseup) — the
  // signal to open a context menu. Right-click always arms a marquee (see
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
  /** The right-drag selection box, in time and container-local y, or null. */
  marquee: MarqueeBox | null;
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
 * Every horizontal drag (annotation create/resize/move, selection create/resize)
 * is applied by ONE function, `processDragAtClientX`, which reads live state
 * through refs. Its two callers are the container's mousemove and the auto-pan
 * loop, so a drag means the same thing whichever of them drives it.
 *
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
  timelineRef,
  annotations,
  layeredAnnotationsRef,
  selection,
  boundAnnotationId,
  multiSelectedIds,
  activeAnnotationTool,
  isPlaying,
  settings,
  sampleRate,
  filterToolActive,
  bandPassFilter,
  currentTimeStore,
  onSeek,
  onAnnotationsChange,
  onAnnotationsCommit,
  onSelectAnnotation,
  onSelectionChange,
  onBoundAnnotationChange,
  onMarqueeSelect,
  onEditAnnotationText,
  onBandPassFilterChange,
  onBandPassFilterDrawn,
  isAltHeldRef,
  onContextMenu,
}: SpectrogramInteractionParams): SpectrogramInteractionApi {
  // Right-button mousedown: screen position (so mouseup can tell a plain
  // right-click, which opens the context menu, from a drag) and where in the
  // track and container the box is anchored.
  const rightDownRef = useRef<{ x: number; y: number; t: number; localY: number } | null>(null);
  const CONTEXT_MENU_MOVE_THRESHOLD_PX = 4;
  // The right-drag selection box: time on x (so it holds still under auto-pan
  // and wheel scroll), container-local pixels on y.
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);

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
  const marqueeRef = useRef(marquee);
  const annotationsRef = useRef(annotations);
  const boundAnnotationIdRef = useRef(boundAnnotationId);
  const multiSelectedIdsRef = useRef(multiSelectedIds);
  const selectionRef = useRef(selection);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onAnnotationsChangeRef = useRef(onAnnotationsChange);
  const onSeekRef = useRef(onSeek);
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
  marqueeRef.current = marquee;
  annotationsRef.current = annotations;
  boundAnnotationIdRef.current = boundAnnotationId;
  multiSelectedIdsRef.current = multiSelectedIds;
  selectionRef.current = selection;
  onSelectionChangeRef.current = onSelectionChange;
  onAnnotationsChangeRef.current = onAnnotationsChange;
  onSeekRef.current = onSeek;

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
    return clamp(t, 0, durationRef.current);
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

  // The annotations a gesture on `id` applies to: the whole Shift-selected set
  // if `id` is in it, else just `id`.
  const gestureGroup = (id: string): Set<string> =>
    multiSelectedIdsRef.current.includes(id) ? new Set(multiSelectedIdsRef.current) : new Set([id]);

  // The span an annotation must stay inside: the subset span it is in, within
  // the track. Both edges, so a gesture can't carry it across a cut.
  const spanOf = (a: Annotation) => {
    const tl = timelineRef.current;
    return {
      lo: Math.max(0, tl.clampToSpanOfDisplay(a.start, 0)),
      hi: Math.min(durationRef.current, tl.clampToSpanOfDisplay(a.start, durationRef.current)),
    };
  };

  // Shift one edge (or both) of the gesture's annotations by whatever moves the
  // lead one to `want`, held to the most restrictive member so the set keeps its
  // shape. `viewport` (pointer-driven moves; auto-pan owns scrolling past the
  // edge) confines the lead alone — a member that is already off-screen mustn't
  // drag the set back into view. The one place a drag is applied, shared by the
  // move, the resize and the auto-pan loop so none can skip a clamp.
  // Returns the updated list and the lead annotation in it.
  const shiftGroup = (
    id: string,
    side: 'start' | 'end' | 'both',
    wantFor: (lead: Annotation) => number,
    viewport?: { left: number; right: number },
  ) => {
    const list = annotationsRef.current;
    const lead = list.find(a => a.id === id);
    if (!lead) return null;
    const group = gestureGroup(id);
    const ranges = list.filter(a => group.has(a.id)).map(a => {
      const span = spanOf(a);
      if (a.id === id && viewport) {
        span.lo = Math.max(span.lo, viewport.left);
        span.hi = Math.min(span.hi, viewport.right);
      }
      return deltaRange(a, side, span);
    });
    const delta = clampSharedDelta(wantFor(lead), ranges);
    const updated = shiftAnnotations(list, group, side, delta);
    pendingAnnotationsRef.current = updated;
    onAnnotationsChangeRef.current(updated);
    return { updated, lead: updated.find(a => a.id === id)! };
  };

  // Move the dragged annotation (and any it is selected with). `startFor`
  // proposes the new start for it.
  const placeDraggedAnnotation = (
    id: string,
    startFor: (a: Annotation, dur: number) => number,
    viewport?: { left: number; right: number },
  ) => {
    const r = shiftGroup(id, 'both', lead => startFor(lead, lead.end - lead.start) - lead.start, viewport);
    if (!r) return;
    if (id === boundAnnotationIdRef.current) onSelectionChangeRef.current({ start: r.lead.start, end: r.lead.end });
    if (playheadFollowsAnnotationStartRef.current) onSeekRef.current(r.lead.start);
  };

  // The one implementation of every horizontal drag, driven by the container's
  // mousemove and by the auto-pan loop. Reads only refs — safe from a RAF loop
  // or a window handler.
  const processDragAtClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pps = pixelsPerSecondRef.current;
    const rawT = clamp(
      xToTime(clientX - rect.left, scrollLeftRef.current, pps),
      0,
      durationRef.current,
    );
    const held = (anchor: number) => holdInSpan(anchor, rawT);

    const mq = marqueeRef.current;
    if (mq) {
      const y = (mousePosRef.current?.clientY ?? rect.top) - rect.top;
      setMarquee({ ...mq, t1: rawT, y1: clamp(y, 0, rect.height) });
      return;
    }

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
      // Anchored on the edge that isn't moving.
      const r = shiftGroup(ra.id, ra.side, lead => ra.side === 'start'
        ? Math.min(held(lead.end), lead.end - MIN_ANNOTATION_SEC) - lead.start
        : Math.max(held(lead.start), lead.start + MIN_ANNOTATION_SEC) - lead.end);
      if (r) {
        if (ra.id === boundAnnotationIdRef.current) onSelectionChangeRef.current({ start: r.lead.start, end: r.lead.end });
        if (playheadFollowsAnnotationStartRef.current && ra.side === 'start') onSeekRef.current(r.lead.start);
      }
      return;
    }

    const da = draggedAnnotationRef.current;
    if (da) {
      const viewLeft = scrollLeftRef.current / pps;
      placeDraggedAnnotation(
        da.id,
        a => held(a.start) - da.startOffset,
        { left: viewLeft, right: viewLeft + rect.width / pps },
      );
      return;
    }

    const rsh = resizingSelectionHandleRef.current;
    const sel = selectionRef.current;
    if (rsh && sel) {
      let newStart = sel.start;
      let newEnd = sel.end;
      if (rsh === 'start') newStart = Math.min(held(sel.end), sel.end - 0.05);
      else newEnd = Math.max(held(sel.start), sel.start + 0.05);
      onSelectionChangeRef.current({
        start: newStart,
        end: newEnd,
        // The edge that isn't moving, so a later Shift+arrow carries on from it.
        anchor: rsh === 'start' ? newEnd : newStart,
      });
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
    resizingSelectionHandle !== null || marquee !== null;

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
    return addWindowListener('mousemove', trackMouse, { passive: true });
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

      if (resizingFilterEdge !== null && bandPassFilter) {
        onBandPassFilterChange(
          resizeFilterEdge(resizingFilterEdge, e.clientY, rect.top, canvasHeight, bandPassFilter, settings, sampleRate / 2),
        );
      } else if (creatingFilter !== null) {
        setCreatingFilter({ ...creatingFilter, y1: clamp(e.clientY - rect.top, 0, canvasHeight) });
      }
    };
    return addWindowListener('mousemove', onMove);
  }, [isFilterDragActive, creatingFilter, resizingFilterEdge, bandPassFilter, settings, sampleRate, onBandPassFilterChange]);

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
    const prev = new Map<Window, string>();
    forEachWindow(w => {
      prev.set(w, w.document.body.style.userSelect);
      w.document.body.style.userSelect = 'none';
    });
    return () => prev.forEach((v, w) => { w.document.body.style.userSelect = v; });
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
          const rightBound = (containerRef.current?.ownerDocument.defaultView ?? window).innerWidth - AUTOPAN_EDGE_MARGIN;
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
            placeDraggedAnnotation(
              da2.id,
              (_a, annotDur) => (overflow < 0 ? viewLeft : viewRight - annotDur),
            );
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
      const rect = containerRef.current?.getBoundingClientRect();
      rightDownRef.current = {
        x: e.clientX, y: e.clientY, t: getPointerTime(e), localY: rect ? e.clientY - rect.top : 0,
      };
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

    // Right button held: until the pointer has travelled past the click
    // threshold this is still a right-click; past it, a box begins.
    const down = rightDownRef.current;
    if (down && !marqueeRef.current) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= CONTEXT_MENU_MOVE_THRESHOLD_PX) {
        setMarquee({ t0: down.t, y0: down.localY, t1: getPointerTime(e), y1: clamp(e.clientY - (containerRef.current?.getBoundingClientRect().top ?? 0), 0, containerRef.current?.clientHeight ?? 0) });
      }
      return;
    }

    // Filter drags are vertical and tracked by the window-level listener above
    // (they must continue outside the container); doing it here too would apply
    // every move twice.
    if (isFilterDragActiveRef.current) return;

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

    processDragAtClientX(e.clientX);
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    if (rightDownRef.current) {
      const down = rightDownRef.current;
      rightDownRef.current = null;
      if (marquee) {
        onMarqueeSelect(annotationsInBox(layeredAnnotationsRef.current, marquee));
        setMarquee(null);
      } else if (e && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CONTEXT_MENU_MOVE_THRESHOLD_PX) {
        onContextMenu?.(e.clientX, e.clientY);
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
        // Dragging to the very top/bottom of the view snaps to the file's full
        // range rather than the visible window's edge (matches edge-resize).
        const high = yTop <= 0
          ? sampleRate / 2
          : yToFreq(yTop, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
        const low = yBottom >= canvasHeight
          ? FILTER_FLOOR_HZ
          : yToFreq(yBottom, canvasHeight, settings.minFreq, settings.maxFreq, settings.frequencyScale);
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
    return addWindowListener('mouseup', onWindowMouseUp);
  }, []);

  return {
    creatingAnnotation,
    commitSpan,
    creatingSelection,
    creatingFilter,
    marquee,
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
