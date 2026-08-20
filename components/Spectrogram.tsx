import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Annotation, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter, VideoMode } from '../types';
import { bandExtentY, freqToY, freqAxisTicks } from '../utils/audioProcessing';
import { calculateAnnotationLayers, clamp, annotationColorStyle, annotationBoxTop, ANNOTATION_BOX_HEIGHT } from '../utils/helpers';
import { chooseTimeStep, formatRulerTime, rulerLabelAlign, rulerTicks, DATETIME_LABEL_SPACING_PX, RulerTick } from '../utils/timeAxis';
import { datetimeTicks, formatDatetimeRulerLabel, DateTimeFormat } from '../utils/datetimeDisplay';
import type { TimeDisplayUnit } from '../utils/helpers';
import { spanBetween } from '../utils/selectionExtend';
import { timeToX, maxScroll as computeMaxScroll, centerScrollLeft } from '../utils/viewportTransform';
import {
  MIN_SEGMENT_JOIN_PX,
  Timeline,
  identityTimeline,
  minSegmentDuration,
  segmentJoins,
} from '../utils/subsetTimeline';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { MIN_ZOOM_SEC, Y_AXIS_WIDTH, DEFAULT_DATE_TIME_FORMAT } from '../constants';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import SelectionHandles from './spectrogram/SelectionHandles';
import FilterHandles from './spectrogram/FilterHandles';
import AnnotationOverlay from './spectrogram/AnnotationOverlay';
import { useChunkRenderer, DIAG_FRAME_TIMING } from '../hooks/useChunkRenderer';
import { useSpectrogramInteraction } from '../hooks/useSpectrogramInteraction';
import { useAltHeld } from '../hooks/useAltHeld';
import { spectrogramView } from '../copy/ui';
import ContextMenu from './ContextMenu';

interface SpectrogramProps {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
  cacheVersion: number;
  // Playback time arrives via a ref-based pub/sub store (not a prop) so a
  // playback tick redraws the canvas imperatively without re-rendering the tree.
  currentTimeStore: CurrentTimeStore;
  // DISPLAY duration: how long the timeline being shown is. Equals the file's
  // duration unless a subset is active, in which case it's the kept total.
  duration: number;
  /**
   * Display->source map (utils/subsetTimeline). Everything this component does
   * is already in display time, so the timeline is needed in exactly two places:
   * the chunk renderer, which looks up each column's audio by source time, and
   * the interaction hook, which holds drags inside one span. Defaults to the
   * identity timeline, i.e. no subset.
   */
  timeline?: Timeline;
  isPlaying: boolean;
  isProcessing: boolean;
  ident: string | null;
  settings: SpectrogramSettings;
  zoomSec: number;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  // null = Selection Mode (no annotation tool active)
  activeAnnotationTool: AnnotationTool | null;
  annotationTools: AnnotationTool[];
  selection: Selection | null;
  /**
   * Start of an in-progress keyboard sweep (Shift held during playback — see
   * hooks/useShiftSweep), or null. Drawn as a live span from here to the
   * playhead; it isn't a real selection until the key comes up.
   */
  sweepStart?: number | null;
  boundAnnotationId: string | null;
  filterToolActive: boolean;
  bandPassFilter: BandPassFilter | null;
  /** Edit-in-place geometry updates (cutoff resize). Does NOT push the stack. */
  onBandPassFilterChange: (f: BandPassFilter | null) => void;
  /** Called when a band is freshly drawn via drag — pushes `filterBand` and engages filtering. */
  onBandPassFilterDrawn: (f: BandPassFilter) => void;
  /** Most recent of {annotationTool, filterTool} in the activation stack, or null. Drives cursor orientation. */
  topTool: 'annotationTool' | 'filterTool' | null;
  onSeek: (time: number) => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onZoomChange: (newZoomSec: number) => void;
  /**
   * Fired on scroll, zoom, and resize with the current time→pixel transform.
   * The single source of truth that the buzzdetect panel consumes for
   * pixel-exact x-alignment with the spectrogram (`x = t*pps − scrollLeft`).
   * Optional so callers that don't need it pay nothing.
   */
  onViewportChange?: (viewport: { scrollLeft: number; pixelsPerSecond: number; containerWidth: number }) => void;
  videoMode?: VideoMode;
  isAudioTrack?: boolean;
  playheadLocked?: boolean;
  hideLabels?: boolean;
  /**
   * Wall-clock start of the track, parsed from its filename (null when the
   * project defines no timestamp format or the name doesn't match). With
   * `timeDisplayUnit === 'datetime'` the ruler shows real datetimes.
   */
  trackStartDate?: Date | null;
  timeDisplayUnit?: TimeDisplayUnit;
  /** Style for wall-clock datetimes on the ruler. */
  dateTimeFormat?: DateTimeFormat;
  /**
   * Export the current selection's audio to a file (save dialog + Rust decode
   * + encode). Offered on the spectrogram's right-click context menu,
   * disabled there when there is no selection. Omit to not offer export at all
   * (e.g. a track type export doesn't apply to).
   */
  onExportSelection?: () => void;
}

export interface SpectrogramHandle {
  goToPrevAnnotation: () => void;
  goToNextAnnotation: () => void;
  goToTrackStart: () => void;
  goToTrackEnd: () => void;
  scrollToTime: (time: number) => void;
  /** Pan just enough to bring `time` inside the visible window, or not at all. */
  revealTime: (time: number) => void;
  /**
   * Commit a span drawn out by something other than the mouse (the keyboard
   * sweep). Goes through the same rule as a drag: an annotation when a tool is
   * readied, a selection otherwise.
   */
  commitSpan: (start: number, end: number, quiet?: boolean) => void;
  recenterPlayhead: () => void;
  zoomToRange: (startTime: number, endTime: number) => void;
  applyWheel: (deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  focusAnnotationInput: (id: string) => void;
}

// How close a keyboard-walked edge may get to the frame before the view pans
// to keep it in sight.
const REVEAL_MARGIN_PX = 48;

// Flip to true to trace everything that can move the view sideways: every
// scroll write (tagged with its source), every ResizeObserver notification with
// the exact widths involved, every wheel event, every zoom-prop change, and a
// 250ms heartbeat of the live geometry. Kept because this file has now grown
// two separate self-sustaining scroll loops (the "violent jitter" oscillation
// and the compounding resize rescale), and the source tags are what identify
// them; the heartbeat separates "something keeps writing scroll" from "scroll
// is still but the render drifts". Same idea as DIAG_FRAME_TIMING.
const DIAG_SCROLL = false;
const diagT0 = typeof performance !== 'undefined' ? performance.now() : 0;
// Cap so a long session can't fill the console with megabytes of trace.
let diagCount = 0;
const diag = (msg: string) => {
  if (!DIAG_SCROLL || diagCount > 3000) return;
  diagCount++;
  // eslint-disable-next-line no-console
  console.log(`[scrolldiag +${((performance.now() - diagT0) / 1000).toFixed(3)}s] ${msg}`);
};

// The scroll clamp (40%-of-viewport overrun past the end) lives in
// utils/viewportTransform as `maxScroll`, imported here as `computeMaxScroll`
// so auto-pan, right-drag pan, wheel zoom/pan, and the recenter action all
// share one source of truth.

const Spectrogram = forwardRef<SpectrogramHandle, SpectrogramProps>(({
  chunkCache,
  sampleRate,
  cacheVersion,
  currentTimeStore,
  duration,
  timeline,
  isPlaying,
  isProcessing,
  ident,
  settings,
  zoomSec,
  annotations,
  selectedAnnotationId,
  activeAnnotationTool,
  annotationTools,
  selection,
  sweepStart = null,
  boundAnnotationId,
  filterToolActive,
  bandPassFilter,
  onBandPassFilterChange,
  onBandPassFilterDrawn,
  topTool,
  onSeek,
  onAnnotationsChange,
  onAnnotationsCommit,
  onSelectAnnotation,
  onSelectionChange,
  onBoundAnnotationChange,
  onZoomChange,
  onViewportChange,
  videoMode,
  isAudioTrack = false,
  playheadLocked = false,
  hideLabels = false,
  trackStartDate = null,
  timeDisplayUnit = 'seconds',
  dateTimeFormat = DEFAULT_DATE_TIME_FORMAT,
  onExportSelection,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Screen position of a pending right-click context menu, or null when closed.
  // Opened by the interaction hook's onContextMenu (a right-click that didn't
  // turn into a pan drag — see useSpectrogramInteraction).
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!offscreenCanvasRef.current && typeof document !== 'undefined') {
    offscreenCanvasRef.current = document.createElement('canvas');
  }
  // Overlay canvas: draws playhead, time ruler, ident, and selection darkening.
  // Must be above annotation HTML divs (z-30 > annotations z-10/20).
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // Band-pass filter darkening canvas: sits BELOW the annotation HTML divs so
  // filter darkening never dims annotation labels — they must stay full
  // brightness regardless of filter state.
  const filterOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // Y-axis canvas: separate element to the left of the spectrogram area, never layered on top of spectrogram content.
  const yAxisCanvasRef = useRef<HTMLCanvasElement>(null);

  // Internal scroll state (in pixels)
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollLeftRef = useRef(0);
  // scrollLeftRef is the source of truth, written synchronously by setScroll;
  // the state is a render mirror. There must be NO backward state→ref sync:
  // React commits from different tasks (wheel vs ResizeObserver) can land out
  // of order, and syncing the ref from a stale commit regresses it — the
  // resize handler then re-derives scroll from the regressed ref and re-queues
  // the stale value, producing a self-sustaining two-position oscillation
  // (the "violent jitter" bug). Every scroll write must go through setScroll.
  const setScroll = useCallback((v: number, _source: string = '?') => {
    if (DIAG_SCROLL && Math.abs(v - scrollLeftRef.current) > 0.0001) {
      diag(`write  ${_source.padEnd(18)} ${scrollLeftRef.current.toFixed(2)} -> ${v.toFixed(2)}  (d=${(v - scrollLeftRef.current).toFixed(3)})  ppsRef=${pixelsPerSecondRef.current.toFixed(6)} zoomRef=${zoomSecRef.current}`);
    }
    scrollLeftRef.current = v;
    setScrollLeft(v);
    // Every layer's geometry is a function of scrollLeft, and all three read it
    // live from scrollLeftRef rather than from a prop — so moving the view is
    // exactly the event that dirties them. Marking them here (not leaning on a
    // dep-driven effect) is what makes a paused pan repaint: `draw` takes the
    // scroll through a ref, so its identity does NOT change on a scroll step and
    // the draw/drawYAxis useLayoutEffect below never fires for one. While
    // playing the media-clock tick happened to cover it, which is why panning
    // only ever looked broken when stopped.
    drawDirtyRef.current = true;
    overlayDirtyRef.current = true;
    filterOverlayDirtyRef.current = true;
  }, []);
  // Timestamp (ms) of the last user-initiated scroll. Used to suppress auto-scroll
  // for a brief window after manual panning so the two don't fight each other.
  const lastManualScrollRef = useRef(0);

  // Custom cursor position (relative to the spectrogram container)
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [suppressCustomCursor, setSuppressCustomCursor] = useState(false);

  // Hovered annotation id for hover effects (delete button, pencil icon)
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for input focus (pencil icon click)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pencilClickedId, setPencilClickedId] = useState<string | null>(null);
  // Tracks which annotation is currently in text-edit mode (only via pencil)
  const [editingInputId, setEditingInputId] = useState<string | null>(null);

  const handleAnnotationMouseEnter = useCallback((id: string) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHoveredAnnotationId(id);
  }, []);

  const handleAnnotationMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHoveredAnnotationId(null), 300);
  }, []);

  // Focus (and select all text in) the input when the pencil is clicked or
  // an annotation's label is retargeted via focusAnnotationInput.
  useEffect(() => {
    if (pencilClickedId) {
      const el = inputRefs.current[pencilClickedId];
      el?.focus();
      el?.select();
      setPencilClickedId(null);
    }
  }, [pencilClickedId]);

  const requestRef = useRef<number | null>(null);

  // The chunk-rendering buffer pools and incremental-scroll state now live in
  // useChunkRenderer (called below); only the dirty flag + function pointers
  // that the rAF loop drives stay here.

  // Dirty flag: set whenever draw/drawYAxis deps change so the rAF loop only
  // calls the expensive spectrogram render when the background actually changed.
  const drawDirtyRef = useRef(true);
  const drawRef = useRef<() => void>(() => {});
  const drawYAxisRef = useRef<() => void>(() => {});

  // Shared geometry refs read by the render path (drawOverlay, ResizeObserver,
  // autoScroll, applyWheel) AND by the interaction hook's auto-pan loop. Owned
  // here because the scroll/zoom/render code also writes through them; passed
  // into useSpectrogramInteraction so its rAF loop reads them stale-closure-free.
  const pixelsPerSecondRef = useRef(0);
  const durationRef = useRef(duration);
  // Read live by the interaction hook's rAF loop and window handlers. Memoised
  // because the chunk renderer's `draw` depends on it: a fresh identity timeline
  // per render would dirty the spectrogram background every frame.
  const fallbackTimeline = useMemo(() => identityTimeline(duration), [duration]);
  const activeTimeline = timeline ?? fallbackTimeline;
  const timelineRef = useRef(activeTimeline);
  timelineRef.current = activeTimeline;
  // Display-time seams between spliced-together spans, so the overlay can mark
  // them — subset audio reads as continuous, but the cut is still a real jump
  // in the source file, worth flagging visually.
  const subsetJoins = useMemo(() => segmentJoins(activeTimeline), [activeTimeline]);
  // Shortest segment on the axis. Zoomed far enough out that segments are only
  // a pixel or two wide, the seams between them stop reading as splices and
  // merge into a solid gold wall — so below MIN_SEGMENT_JOIN_PX they aren't
  // drawn, the same way frame boundaries drop out once frames are too tight to
  // tell apart. Memoised: the draw below runs every frame.
  const minSegmentSec = useMemo(() => minSegmentDuration(activeTimeline), [activeTimeline]);
  // Lets the lifetime rAF loop (empty-dep effect) read live isPlaying for the
  // frame-timing diagnostic without resubscribing.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // The container's CONTENT-BOX width, straight from the ResizeObserver — so it
  // is fractional (a flex child lands on sub-pixel boundaries: 810.15625, not
  // 810). Every pixels-per-second derivation must use this same width, never
  // `clientWidth`, which rounds to an integer: two pps values that disagree by
  // that rounding turn the resize handler's scroll rescale into a small
  // constant multiplier instead of an identity.
  const [containerWidth, setContainerWidth] = useState(0);
  // Diagnostic mirror only (see DIAG_SCROLL).
  const containerWidthRef = useRef(0);
  containerWidthRef.current = containerWidth;
  // Last width the ResizeObserver reported, so a notification that carries no
  // actual size change can skip the scroll rescale entirely.
  const lastObservedWidthRef = useRef(0);

  // True while the visible viewport still has chunks resolving (first load or a
  // settings-driven rebuild). Drives the "building spectrogram" veil. Reconciled
  // inside useChunkRenderer's draw() (which knows the active tier and iterates
  // columns), guarded so setState only fires on an actual transition.
  const [isBuilding, setIsBuilding] = useState(false);

  const pixelsPerSecond = useMemo(() => {
     if (containerWidth === 0) return 100;
     return containerWidth / zoomSec;
  }, [zoomSec, containerWidth]);

  const zoomSecRef = useRef(zoomSec);

  // Keep refs in sync so RAF/window handlers read current values without stale
  // closures.
  //
  // pixelsPerSecondRef follows the same rule as scrollLeftRef above: the zoom
  // actions write it SYNCHRONOUSLY, and render must not push a stale prop back
  // over a fresher write. `zoomSec` is owned by the parent, so a zoom lands in
  // the ref one commit before it lands in the prop; an unconditional
  // `ref = pixelsPerSecond` here would regress the ref for that commit. The rAF
  // draw reads scrollLeft and pixelsPerSecond live, so a regressed pps pairs the
  // NEW scroll offset with the OLD zoom — startTime = newScroll / oldPps points
  // at an unrelated part of the file, which showed up as a one-frame flash of a
  // different region every time the zoom level changed.
  //
  // Writing only when the inputs actually change keeps genuine external changes
  // (toolbar zoom, container resize, track switch) flowing through while leaving
  // a synchronous write from this frame's zoom action intact.
  const prevZoomInputsRef = useRef({ zoomSec: -1, containerWidth: -1 });
  if (prevZoomInputsRef.current.zoomSec !== zoomSec ||
      prevZoomInputsRef.current.containerWidth !== containerWidth) {
    diag(`zoomin prop zoomSec ${prevZoomInputsRef.current.zoomSec} -> ${zoomSec}, containerWidth ${prevZoomInputsRef.current.containerWidth} -> ${containerWidth}; ppsRef ${pixelsPerSecondRef.current.toFixed(6)} -> ${pixelsPerSecond.toFixed(6)}`);
    prevZoomInputsRef.current = { zoomSec, containerWidth };
    pixelsPerSecondRef.current = pixelsPerSecond;
    zoomSecRef.current = zoomSec;
  }
  durationRef.current = duration;

  // Holding Alt suspends playhead lock: while the user is alt-dragging annotations
  // over what they just heard, the view must not scroll out from under the pointer.
  // Read through a ref so the auto-scroll subscription doesn't churn on every
  // press/release; the next store tick picks the lock back up on release. Also
  // read live (not captured at mousedown) by useSpectrogramInteraction so toggling
  // Alt mid-drag can flip whether the just-created annotation gets highlighted.
  const altHeld = useAltHeld();
  const altHeldRef = useRef(altHeld);
  altHeldRef.current = altHeld;

  // --- Interaction Handlers ---
  // The pointer-interaction core (annotation/selection/filter create/resize/drag,
  // click-vs-drag detection, pending-intent refs, the out-of-bounds auto-pan rAF
  // loop, and the window-level mouseup/mousemove handlers) lives in
  // useSpectrogramInteraction. It owns the ~mirror refs that defeat stale closures
  // in those loops/handlers; the shared geometry refs and setScroll are passed in
  // because the scroll/zoom/render path here also writes through them.
  const {
    commitSpan,
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
  } = useSpectrogramInteraction({
    containerRef,
    scrollLeftRef,
    pixelsPerSecondRef,
    durationRef,
    setScroll,
    scrollLeft,
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
    onBandPassFilterChange,
    onBandPassFilterDrawn,
    setCursorPos,
    setSuppressCustomCursor,
    lastManualScrollRef,
    isAltHeldRef: altHeldRef,
    onContextMenu: (clientX, clientY) => setContextMenuPos({ x: clientX, y: clientY }),
  });

  // Reset scroll position to 0 when switching tracks
  useEffect(() => {
    setScroll(0, 'identReset');
  }, [ident, setScroll]);

  // Tracks which selection the auto-scroll effect below has already suppressed a tick
  // for, so a large/lingering selection doesn't freeze auto-scroll indefinitely.
  const lastSuppressedSelectionRef = useRef<Selection | null>(null);

  // Publish the time→pixel transform whenever it changes (scroll, zoom, resize).
  // Also fires when `onViewportChange` itself becomes available (e.g. the panel
  // is toggled on) so a freshly-mounted consumer gets the current viewport
  // immediately instead of waiting for the next scroll. AnnotationWindow passes
  // a stable setter, so this never loops.
  useEffect(() => {
    onViewportChange?.({ scrollLeft, pixelsPerSecond, containerWidth });
  }, [onViewportChange, scrollLeft, pixelsPerSecond, containerWidth]);

  // Sync scroll with playback — center the playhead once it reaches the center of the
  // currently-visible window. Suppressed for a single tick right after a new selection
  // appears while the playhead is inside it: the user just positioned the canvas
  // intentionally relative to that selection (e.g. a buzzdetect-panel click sets a
  // one-bin selection) and an immediate auto-scroll would yank the view away. Tracked
  // by identity (lastSuppressedSelectionRef) rather than by re-checking the time range
  // on every tick — a large/lingering selection must not freeze auto-scroll for as long
  // as the playhead happens to stay inside it.
  // Also disabled when the entire file fits in the viewport (zoom ≤ 100%): in that case
  // the playhead can travel the full width of the screen without the view moving.
  //
  // Driven by the currentTime store rather than React state: the store fires its
  // subscribers on each media-clock tick (same cadence as the old per-tick render),
  // and we run the identical centering check imperatively. setScrollLeft only fires
  // when the playhead reaches the visible centre, so this triggers a render only on
  // an actual scroll step — never the whole-tree per-tick render we used to pay.
  // Re-subscribes only when these (infrequently changing) inputs change; reads the
  // live time from the store so the playhead and the scroll stay in lockstep.
  useEffect(() => {
      const autoScroll = () => {
          if (!playheadLocked || altHeldRef.current || !isPlaying || !containerRef.current) return;
          const t = currentTimeStore.get();
          if (selection && t >= selection.start && t <= selection.end) {
              if (selection !== lastSuppressedSelectionRef.current) {
                  lastSuppressedSelectionRef.current = selection;
                  return;
              }
          }
          const containerWidth = containerRef.current.clientWidth;
          const pps = pixelsPerSecondRef.current;
          if (duration * pps <= containerWidth) return;
          const targetScroll = t * pps - containerWidth / 2;
          setScroll(Math.max(0, targetScroll), 'autoScroll');
      };
      autoScroll();
      return currentTimeStore.subscribe(autoScroll);
  }, [playheadLocked, isPlaying, currentTimeStore, zoomSec, selection, duration]);

  // Chunk-rendering pipeline (two-stage offscreen build + sub-pixel blit, plus
  // the build-progress veil reconciliation) lives in useChunkRenderer. It owns
  // the reusable buffer pools and incremental-scroll state; we keep storing its
  // `draw` into drawRef and driving it from the rAF loop below.
  const { draw } = useChunkRenderer({
    chunkCache,
    sampleRate,
    cacheVersion,
    scrollLeftRef,
    pixelsPerSecondRef,
    pixelsPerSecond,
    duration,
    timeline: activeTimeline,
    settings,
    isProcessing,
    canvasRef,
    offscreenCanvasRef,
    setIsBuilding,
  });

  // Overlay canvas: axis, playhead, ident, and selection region darkening.
  // Rendered above annotation HTML divs (z-30).
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Read playback time from the store at draw time — this runs every rAF frame,
    // so the playhead is always the value the media clock produced this frame.
    const currentTime = currentTimeStore.get();

    const dpr = window.devicePixelRatio || 1;
    // Use the container's CSS width rather than canvas.width/dpr to avoid
    // 1-physical-pixel rounding fluctuations that shift tick positions during playback.
    const width = containerRef.current?.clientWidth ?? canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const scrollLeft_live = scrollLeftRef.current;
    const pixelsPerSecond_live = pixelsPerSecondRef.current || pixelsPerSecond;
    const startTime = scrollLeft_live / pixelsPerSecond_live;
    const timePerPixel = 1 / pixelsPerSecond_live;
    const endTime = startTime + (width * timePerPixel);

    // 1. Selection region darkening / annotation-being-made preview — draw
    // FIRST so other elements render on top. Only show creating-selection
    // darkening once the mouse has moved (not on initial mousedown).
    //
    // Selection creation and annotation-label creation are the same span —
    // by mouse drag, by the Shift-held sweep whose end is wherever the
    // playhead has got to this frame, or a settled selection not yet
    // committed — shaded and spined identically below. They differ only in
    // whether a label draws, gated separately by `previewingAnnotationLabel`.
    const isDraggingSelection = creatingSelection && Math.abs(creatingSelection.current - creatingSelection.start) > 0.001;
    const draggingAnnotationSpan = creatingAnnotation
      ? spanBetween(creatingAnnotation.start, creatingAnnotation.current)
      : null;
    const sweepSpan = sweepStart !== null ? spanBetween(sweepStart, currentTime) : null;
    const creatingSpan = isDraggingSelection
      ? { start: Math.min(creatingSelection.start, creatingSelection.current), end: Math.max(creatingSelection.start, creatingSelection.current) }
      : draggingAnnotationSpan ?? sweepSpan;
    const activeSelection = creatingSpan ?? selection;
    // A tool is armed and this span (drawn, swept, or a settled selection)
    // hasn't already become the real annotation AnnotationOverlay is now
    // rendering — draw its label on top of the shading below.
    const previewingAnnotationLabel = activeSelection !== null && activeAnnotationTool !== null && boundAnnotationId === null;

    if (activeSelection) {
      const selStartX = Math.max(0, timeToX(activeSelection.start, scrollLeft_live, pixelsPerSecond_live));
      const selEndX = Math.min(width, timeToX(activeSelection.end, scrollLeft_live, pixelsPerSecond_live));

      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      // Left dark region
      if (selStartX > 0) {
        ctx.fillRect(0, 0, selStartX, height);
      }
      // Right dark region
      if (selEndX < width) {
        ctx.fillRect(selEndX, 0, width - selEndX, height);
      }
    }

    // 1a. Every selection gets a thin dotted line down its middle — a spine
    // marking what it covers, and the only thing a span still being swept out
    // has to show for itself (no handles, no cursor). With a band-pass band up
    // it runs down the middle of the band instead of the canvas, so the two
    // read as the one region the audio is being taken from.
    if (activeSelection) {
      const x0 = Math.max(0, timeToX(activeSelection.start, scrollLeft_live, pixelsPerSecond_live));
      const x1 = Math.min(width, timeToX(activeSelection.end, scrollLeft_live, pixelsPerSecond_live));
      const band = bandPassFilter
        ? bandExtentY(bandPassFilter, height, settings.minFreq, settings.maxFreq, settings.frequencyScale)
        : null;
      const midY = band ? (band.yTop + band.yBottom) / 2 : height / 2;
      if (x1 > x0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, midY);
        ctx.lineTo(x1, midY);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 1a-ii. Preview of the annotation box this span will become — mouse-drag,
    // keyboard sweep, and a settled Shift+Arrow selection all reach here the
    // same way (see `previewingAnnotationLabel` above). Drawn on top of the
    // shading/spine already drawn for it above, in the same pass so it never
    // lags a frame behind during a live sweep. Same geometry/colors as the
    // real committed box (AnnotationOverlay) — border, background, rounded
    // corners, height, and vertical stacking layer — just not interactive.
    if (previewingAnnotationLabel && activeAnnotationTool) {
      const x0 = Math.max(0, timeToX(activeSelection!.start, scrollLeft_live, pixelsPerSecond_live));
      const x1 = Math.min(width, timeToX(activeSelection!.end, scrollLeft_live, pixelsPerSecond_live));
      if (x1 > x0) {
        const withPreview = calculateAnnotationLayers([
          ...annotations,
          { id: '__preview__', start: activeSelection!.start, end: activeSelection!.end, text: '' },
        ]);
        const layerIndex = withPreview.find(a => a.id === '__preview__')?.layerIndex ?? 0;
        const boxTop = annotationBoxTop(layerIndex);
        const style = annotationColorStyle(activeAnnotationTool.color, false);
        const r = 4;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x0 + r, boxTop);
        ctx.lineTo(x1 - r, boxTop);
        ctx.arcTo(x1, boxTop, x1, boxTop + r, r);
        ctx.lineTo(x1, boxTop + ANNOTATION_BOX_HEIGHT - r);
        ctx.arcTo(x1, boxTop + ANNOTATION_BOX_HEIGHT, x1 - r, boxTop + ANNOTATION_BOX_HEIGHT, r);
        ctx.lineTo(x0 + r, boxTop + ANNOTATION_BOX_HEIGHT);
        ctx.arcTo(x0, boxTop + ANNOTATION_BOX_HEIGHT, x0, boxTop + ANNOTATION_BOX_HEIGHT - r, r);
        ctx.lineTo(x0, boxTop + r);
        ctx.arcTo(x0, boxTop, x0 + r, boxTop, r);
        ctx.closePath();
        ctx.fillStyle = style.bgColor;
        ctx.fill();
        ctx.strokeStyle = style.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        if (x1 - x0 > 30) {
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'black';
          ctx.shadowBlur = 2;
          ctx.shadowOffsetY = 1;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(
            activeAnnotationTool.key === '0' ? 'Custom' : activeAnnotationTool.text,
            x0 + 8,
            boxTop + ANNOTATION_BOX_HEIGHT / 2,
          );
        }
        ctx.restore();
      }
    }

    // 1b. Draw subset segment joins — the seams where the display axis skips
    // from the end of one kept span to the start of the next. Dashed and
    // distinct from the playhead/ruler so a cut reads as a splice, not a marker.
    if (subsetJoins.length > 0 && minSegmentSec * pixelsPerSecond_live >= MIN_SEGMENT_JOIN_PX) {
      ctx.save();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const t of subsetJoins) {
        const x = timeToX(t, scrollLeft_live, pixelsPerSecond_live);
        if (x < 0 || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. Draw Playhead Line
    const playheadX = timeToX(currentTime, scrollLeft_live, pixelsPerSecond_live);
    if (playheadX >= 0 && playheadX <= width) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
    }

    // 3. Draw Time Ruler
    // Choose tick spacing from the stable configured pixelsPerSecond (derived
    // from zoomSec), NOT from the live clientWidth. The latter fluctuates by
    // sub-pixel amounts during playback/panning, which at round zoom levels
    // can flip the chosen step — making labels flicker in and out.
    const timeRange = zoomSec;
    // Datetime ticks land on wall-clock boundaries (the hour, the minute) and
    // carry wider labels, so both the spacing and the tick positions differ
    // from the elapsed-time ruler's multiples-of-step-from-zero.
    const datetimeRuler = timeDisplayUnit === 'datetime' && trackStartDate !== null;
    const timeStep = chooseTimeStep(pixelsPerSecond, datetimeRuler ? DATETIME_LABEL_SPACING_PX : undefined);

    ctx.font = 'bold 12px sans-serif';
    ctx.textBaseline = 'bottom';

    // Ticks are labelled in SOURCE time: under a subset the display axis says
    // nothing about where in the file you are, so the ruler is built per kept
    // span from that span's own file times (see utils/timeAxis). Identity
    // timeline → the same ticks as before, labelled with themselves.
    //
    // Under a subset each tick sits at a segment's START, so its label is
    // left-aligned to the tick line rather than centered on it — centering
    // would make the label read as if it spanned both sides of the cut.
    const tickEndTime = duration > 0 ? Math.min(endTime, duration) : endTime;
    // Wall-clock ticks only land on clock boundaries when the axis runs
    // continuously; under a subset the display axis is spliced, so ticks come
    // from the timeline (one per segment start) and are simply *labelled* as
    // datetimes. Either way each tick carries the source time its label reads.
    const ticks: RulerTick[] = datetimeRuler && timelineRef.current.identity
      ? datetimeTicks(trackStartDate, Math.max(startTime, 0), tickEndTime, timeStep).map(s => ({ disp: s, src: s }))
      : rulerTicks(timelineRef.current, startTime, tickEndTime, timeStep, pixelsPerSecond_live,
          datetimeRuler ? DATETIME_LABEL_SPACING_PX : undefined);
    const labelAlign = rulerLabelAlign(timelineRef.current);
    ctx.textAlign = labelAlign;

    // Only labels actually drawn feed the "what changed since the last label"
    // logic, so scrolling never leaves a view whose first label lacks its date.
    let prevLabelled: number | null = null;
    for (const tick of ticks) {
        const x = timeToX(tick.disp, scrollLeft_live, pixelsPerSecond_live);
        if (x < 0 || x > width) continue;
        ctx.beginPath();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.moveTo(x, height);
        ctx.lineTo(x, height - 8);
        ctx.stroke();

        const timeStr = datetimeRuler
          ? formatDatetimeRulerLabel(trackStartDate, tick.src, prevLabelled, timeStep, dateTimeFormat)
          : formatRulerTime(tick.src, timeStep, timeRange, timeDisplayUnit === 'seconds');
        prevLabelled = tick.src;
        // The leading full-date label is wide enough to hang off the left edge;
        // nudge it back on-canvas rather than letting it clip.
        let labelX = labelAlign === 'left' ? x + 3 : x;
        if (datetimeRuler && labelAlign === 'center') {
          labelX = Math.max(labelX, ctx.measureText(timeStr).width / 2 + 2);
        }
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.strokeText(timeStr, labelX, height - 10);
        ctx.fillStyle = 'white';
        ctx.fillText(timeStr, labelX, height - 10);
    }

    // 5. Draw ident text at top of spectrogram
    if (ident) {
      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(ident, 8, 6);
    }

    ctx.restore();
  // activeTimeline is read through its ref at draw time, but it's a dep as well
  // so a timeline swap repaints the ruler (whose labels come from it).
  }, [scrollLeft, pixelsPerSecond, zoomSec, currentTimeStore, ident, selection, creatingSelection, creatingAnnotation, boundAnnotationId, annotations, sweepStart, duration, subsetJoins, minSegmentSec, activeTimeline, trackStartDate, timeDisplayUnit, dateTimeFormat, activeAnnotationTool, bandPassFilter, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Band-pass filter darkening canvas: renders BELOW the annotation HTML divs
  // (unlike the overlay canvas above) so filter darkening never dims annotation
  // labels — labels must stay full brightness/color regardless of filter state.
  const drawFilterOverlay = useCallback(() => {
    const canvas = filterOverlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = containerRef.current?.clientWidth ?? canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // Render in-progress filter creation OR persistent band. The band overlay
    // tracks `bandPassFilter` (the audio source of truth) — tool readiness
    // (`filterToolActive`) only affects whether the cutoff handles are
    // interactive, not whether the band is visible.
    const filterBand = creatingFilter
      ? {
          yTop: Math.min(creatingFilter.y0, creatingFilter.y1),
          yBottom: Math.max(creatingFilter.y0, creatingFilter.y1),
          strength: bandPassFilter?.strength ?? 1,
        }
      : bandPassFilter
      ? {
          ...bandExtentY(bandPassFilter, height, settings.minFreq, settings.maxFreq, settings.frequencyScale),
          strength: bandPassFilter.strength,
        }
      : null;

    // In Fast mode the filter has no effect on audio, so don't render it.
    // For audio tracks, AudioEngine always handles playback with decoded PCM so
    // the filter always applies — treat as 'accurate' regardless of videoMode.
    // For video tracks in Fast mode the filter has no effect; in Mixed mode without
    // a selection the video element's audio track plays instead of AudioEngine.
    const filterInactive = !isAudioTrack && (videoMode === 'fast' || (videoMode === 'mixed' && !selection));
    if (filterBand && !filterInactive) {
      const darkAlpha = 0.65 * filterBand.strength;
      ctx.fillStyle = `rgba(0, 0, 0, ${darkAlpha})`;
      if (filterBand.yTop > 0) {
        ctx.fillRect(0, 0, width, filterBand.yTop);
      }
      if (filterBand.yBottom < height) {
        ctx.fillRect(0, filterBand.yBottom, width, height - filterBand.yBottom);
      }
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, filterBand.yTop); ctx.lineTo(width, filterBand.yTop);
      ctx.moveTo(0, filterBand.yBottom); ctx.lineTo(width, filterBand.yBottom);
      ctx.stroke();
    } else if (filterBand && !isAudioTrack && videoMode === 'mixed' && !selection) {
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, filterBand.yTop); ctx.lineTo(width, filterBand.yTop);
      ctx.moveTo(0, filterBand.yBottom); ctx.lineTo(width, filterBand.yBottom);
      ctx.stroke();
    }

    ctx.restore();
  }, [creatingFilter, bandPassFilter, videoMode, isAudioTrack, selection, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Y-axis canvas: draws the frequency axis. Separate from the spectrogram area so it is never layered on top.
  const drawYAxis = useCallback(() => {
    const canvas = yAxisCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(0, 0, width, height);

    // Right border line
    ctx.beginPath();
    ctx.moveTo(width - 1, 0);
    ctx.lineTo(width - 1, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    let lastLabelY: number | null = null;
    const MIN_LABEL_SPACING = 13;

    const renderTick = (freq: number) => {
      // Use the shared freq→y mapping so axis labels stay in exact lockstep
      // with the spectrogram renderer (same function, no drift).
      const y = freqToY(freq, height, settings.minFreq, settings.maxFreq, settings.frequencyScale);

      if (y < 0 || y > height) return;
      if (lastLabelY !== null && Math.abs(y - lastLabelY) < MIN_LABEL_SPACING) return;
      lastLabelY = y;

      ctx.beginPath();
      ctx.moveTo(width - 5, y);
      ctx.lineTo(width - 1, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();

      let label = freq.toString();
      if (freq >= 1000) {
        label = (freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1) + 'k';
      }
      ctx.fillText(label, width - 7, y);
    };

    for (const freq of freqAxisTicks(settings.minFreq, settings.maxFreq, settings.frequencyScale)) {
      renderTick(freq);
    }
    ctx.restore();
  }, [settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Keep drawRef/drawYAxisRef current and mark dirty whenever the spectrogram
  // background needs a redraw (scroll, zoom, data, settings changed).
  // useLayoutEffect so the flag is set before the useEffect below can read it.
  useLayoutEffect(() => {
    drawRef.current = draw;
    drawYAxisRef.current = drawYAxis;
    drawDirtyRef.current = true;
  }, [draw, drawYAxis]);

  // The overlay (playhead/selection/ruler) must animate every frame during
  // playback, but playback time no longer flows through React state — so we can't
  // rely on a per-render effect to reschedule the frame. Instead a single
  // self-scheduling rAF loop runs for the component's lifetime and repaints each
  // layer only when its dirty flag is set:
  //   • drawDirty  — expensive spectrogram background (scroll/zoom/data/settings)
  //   • overlayDirty — cheap overlay (playhead moved, selection/filter changed)
  // When idle both flags stay clear and the loop costs two boolean checks/frame.
  const drawOverlayRef = useRef(drawOverlay);
  const overlayDirtyRef = useRef(true);
  useLayoutEffect(() => {
    drawOverlayRef.current = drawOverlay;
    overlayDirtyRef.current = true;
  }, [drawOverlay]);

  // Each media-clock tick marks the overlay dirty so the loop repaints the
  // playhead on the next frame — same cadence as the old per-tick state render,
  // but without re-rendering the React tree.
  useEffect(
    () => currentTimeStore.subscribe(() => { overlayDirtyRef.current = true; }),
    [currentTimeStore],
  );

  // Filter darkening canvas only changes when the band-pass filter itself
  // changes (not every playback tick), so it gets its own dirty flag driven
  // solely by drawFilterOverlay's own deps.
  const drawFilterOverlayRef = useRef(drawFilterOverlay);
  const filterOverlayDirtyRef = useRef(true);
  useLayoutEffect(() => {
    drawFilterOverlayRef.current = drawFilterOverlay;
    filterOverlayDirtyRef.current = true;
  }, [drawFilterOverlay]);

  // The spectrogram background no longer reads scrollLeft from a prop (draw reads
  // scrollLeftRef.current), so a scroll step during playback no longer recreates
  // `draw` and trips the useLayoutEffect dirty flag. Mark the background dirty on
  // each media-clock tick while playing so it redraws every frame and tracks the
  // auto-scroll smoothly — matching the overlay's cadence. Scrolling while
  // stopped is covered by setScroll, which dirties every layer directly.
  useEffect(() => {
    if (!isPlaying) return;
    return currentTimeStore.subscribe(() => { drawDirtyRef.current = true; });
  }, [currentTimeStore, isPlaying]);

  useEffect(() => {
    let lastTs = performance.now();
    const tick = () => {
      // Frame-gap detector: a healthy 60fps loop ticks every ~16.7ms. A gap well
      // over that means the previous frame's work (or a GC pause / React relayout)
      // blew the budget — i.e. a real dropped frame, which is what a playback hitch
      // would be. Logged only while playing so idle/background throttling is quiet.
      if (DIAG_FRAME_TIMING) {
        const now = performance.now();
        const gap = now - lastTs;
        lastTs = now;
        if (isPlayingRef.current && gap > 24) {
          // eslint-disable-next-line no-console
          console.warn(`[frametiming] frame gap ${gap.toFixed(1)}ms (target ~16.7)`);
        }
      }
      if (drawDirtyRef.current) {
        drawRef.current();
        drawYAxisRef.current();
        drawDirtyRef.current = false;
      }
      if (overlayDirtyRef.current) {
        drawOverlayRef.current();
        overlayDirtyRef.current = false;
      }
      if (filterOverlayDirtyRef.current) {
        drawFilterOverlayRef.current();
        filterOverlayDirtyRef.current = false;
      }
      requestRef.current = requestAnimationFrame(tick);
    };
    requestRef.current = requestAnimationFrame(tick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // Diagnostic heartbeat (see DIAG_SCROLL). Reports only when the view actually
  // moved since the last tick, so a still view stays silent and any movement
  // with no matching `write` line above it means the drift is in the render
  // path, not in scrollLeft.
  useEffect(() => {
    if (!DIAG_SCROLL) return;
    let last = scrollLeftRef.current;
    const id = window.setInterval(() => {
      const now = scrollLeftRef.current;
      if (Math.abs(now - last) < 0.0001) return;
      diag(`beat   scroll=${now.toFixed(2)} (moved ${(now - last).toFixed(3)}) t0=${(now / (pixelsPerSecondRef.current || 1)).toFixed(4)}s pps=${pixelsPerSecondRef.current.toFixed(6)} zoomRef=${zoomSecRef.current} clientWidth=${containerRef.current?.clientWidth} playing=${isPlayingRef.current} dragging=${isAnyDragActiveRef.current}`);
      last = now;
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Handle Resize — keep all canvases in sync with their container dimensions.
  //
  // Empty deps deliberately: the draw functions are reached through their refs
  // (kept current by the useLayoutEffects above), so the observer is created
  // exactly once. Subscribing per render was a self-sustaining loop — observe()
  // always delivers an immediate first notification, that notification wrote
  // scroll, the write re-rendered, and the re-render built another observer.
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        const newWidth = Math.max(1, width);
        diag(`resize contentRect.width=${width} clientWidth=${containerRef.current?.clientWidth} stateWidth=${containerWidthRef.current} ppsRef=${pixelsPerSecondRef.current.toFixed(6)} newPps=${(newWidth / zoomSecRef.current).toFixed(6)}`);
        // Preserve the left-edge time across resize: scrollLeft is in pixels and
        // pixelsPerSecond = containerWidth / zoomSec, so a width change would shift
        // the visible time range unless we rescale scrollLeft proportionally.
        //
        // Only on an ACTUAL width change. A notification that reports the width
        // we already have has nothing to preserve, and re-running the rescale
        // then is not a no-op: it divides by the live pps and multiplies by a
        // freshly-derived one, so any disagreement between the two (they were
        // derived from different width sources) multiplies scrollLeft by a
        // constant just off 1.0 — every notification, compounding, in the same
        // direction. Zoomed in, where scrollLeft is large, that reads as the
        // view panning steadily right on its own.
        if (pixelsPerSecondRef.current > 0 && zoomSecRef.current > 0 && newWidth !== lastObservedWidthRef.current) {
          const leftEdgeTime = scrollLeftRef.current / pixelsPerSecondRef.current;
          const newPps = newWidth / zoomSecRef.current;
          const newScrollLeft = leftEdgeTime * newPps;
          setScroll(newScrollLeft, 'resize');
        }
        lastObservedWidthRef.current = newWidth;
        setContainerWidth(newWidth);
        const dpr = window.devicePixelRatio || 1;
        if (canvasRef.current) {
          canvasRef.current.width = Math.max(1, Math.round(newWidth * dpr));
          canvasRef.current.height = Math.max(1, Math.round(height * dpr));
        }
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.width = newWidth * dpr;
          overlayCanvasRef.current.height = height * dpr;
        }
        if (filterOverlayCanvasRef.current) {
          filterOverlayCanvasRef.current.width = newWidth * dpr;
          filterOverlayCanvasRef.current.height = height * dpr;
        }
        if (yAxisCanvasRef.current) {
          yAxisCanvasRef.current.width = Y_AXIS_WIDTH * dpr;
          yAxisCanvasRef.current.height = height * dpr;
        }
        // Resizing a canvas clears it, so repaint every layer immediately rather
        // than waiting a frame for the rAF loop's dirty flags.
        drawRef.current();
        drawOverlayRef.current();
        drawFilterOverlayRef.current();
        drawYAxisRef.current();
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, []);

  // --- Annotation navigation ---

  const sortedAnnotations = useMemo(() => [...annotations].sort((a, b) => a.start - b.start), [annotations]);

  const scrollToAnnotation = useCallback((annotStart: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const targetScrollLeft = (annotStart * pixelsPerSecond) - (containerWidth * 0.25);
    setScroll(Math.max(0, targetScrollLeft), 'scrollToAnnotation');
  }, [pixelsPerSecond, setScroll]);

  const goToPrevAnnotation = useCallback(() => {
    if (selection !== null) {
      const t = currentTimeStore.get();
      if (Math.abs(t - selection.start) <= 0.05) {
        // Second press: already at selection start — clear selection and fall through to prev annotation
        onSelectionChange(null);
        onBoundAnnotationChange(null);
      } else {
        // First press: jump to selection start
        onSeek(selection.start);
        scrollToAnnotation(selection.start);
        return;
      }
    }
    const prev = [...sortedAnnotations].reverse().find(a => a.start < currentTimeStore.get() - 0.05);
    if (prev) {
      onSeek(prev.start);
      scrollToAnnotation(prev.start);
    } else {
      onSeek(0);
      scrollToAnnotation(0);
    }
  }, [sortedAnnotations, currentTimeStore, onSeek, scrollToAnnotation, selection, onSelectionChange, onBoundAnnotationChange]);

  const goToNextAnnotation = useCallback(() => {
    // Any active selection (free or bound): jump to selection end
    if (selection !== null) {
      onSeek(selection.end);
      scrollToAnnotation(selection.end);
      return;
    }
    const next = sortedAnnotations.find(a => a.start > currentTimeStore.get() + 0.05);
    if (next) {
      onSeek(next.start);
      scrollToAnnotation(next.start);
    } else {
      onSeek(duration);
      scrollToAnnotation(duration);
    }
  }, [sortedAnnotations, currentTimeStore, duration, onSeek, scrollToAnnotation, selection]);

  // Track start/end: unlike prev/next annotation, these always clear any
  // active selection/binding rather than jumping to its edge first — they're
  // an unconditional "go to the absolute start/end" action.
  const goToTrackStart = useCallback(() => {
    onSeek(0);
    scrollToAnnotation(0);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  }, [onSeek, scrollToAnnotation, onSelectionChange, onBoundAnnotationChange]);

  const goToTrackEnd = useCallback(() => {
    onSeek(duration);
    scrollToAnnotation(duration);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  }, [onSeek, scrollToAnnotation, duration, onSelectionChange, onBoundAnnotationChange]);

  const scrollToTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    setScroll(centerScrollLeft(time, pixelsPerSecond, containerWidth, duration), 'scrollToTime');
  }, [pixelsPerSecond, duration, setScroll]);

  // Minimal pan: bring `time` inside the window, keeping a margin so the edge
  // being walked never sits flush against the frame. Does nothing while it's
  // already comfortably in view — this follows a keyboard-driven edge the way
  // auto-pan follows a dragged one, and a centering scroll on every step would
  // make the whole spectrogram slide under a still cursor.
  const revealTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const pps = pixelsPerSecondRef.current || pixelsPerSecond;
    const margin = Math.min(REVEAL_MARGIN_PX, containerWidth / 4);
    const x = time * pps - scrollLeftRef.current;
    let target = scrollLeftRef.current;
    if (x < margin) target = time * pps - margin;
    else if (x > containerWidth - margin) target = time * pps - (containerWidth - margin);
    else return;
    const clamped = clamp(target, 0, computeMaxScroll(duration, pps, containerWidth));
    if (Math.abs(clamped - scrollLeftRef.current) > 0.01) setScroll(clamped, 'revealTime');
  }, [pixelsPerSecond, duration, setScroll]);

  // Recenter the playhead in the visible window without changing zoom.
  const recenterPlayhead = useCallback(() => {
    scrollToTime(currentTimeStore.get());
  }, [scrollToTime, currentTimeStore]);

  // Escape handling lives in AnnotationWindow (universal activation-stack
  // unwind). When `Esc` pops `selection`, AnnotationWindow also clears
  // boundAnnotationId, so this component no longer registers an Esc binding.


  const applyWheel = useCallback((deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => {
    diag(`wheel  dx=${deltaX} dy=${deltaY} ctrl=${ctrlKey} meta=${metaKey} clientX=${clientX} zoomProp=${zoomSec} zoomRef=${zoomSecRef.current} scrollState=${scrollLeft.toFixed(2)} scrollRef=${scrollLeftRef.current.toFixed(2)} clientWidth=${containerRef.current?.clientWidth} stateWidth=${containerWidth}`);
    if (ctrlKey || metaKey) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      // `containerWidth` (the ResizeObserver's fractional content-box width),
      // NOT clientWidth: this is where pixelsPerSecondRef gets written, and it
      // has to agree exactly with the pps the resize handler derives, or the
      // two disagree by the integer rounding for as long as the zoom lasts.
      const currentPps = containerWidth / zoomSec;
      const timeAtMouse = (scrollLeft + mouseX) / currentPps;
      const zoomFactor = 1.25;
      // Trackpad inertia tails deliver horizontal-only events (deltaY === 0).
      // `deltaY > 0 ? 1 : -1` would treat every one of those as a zoom-in step,
      // making the view zoom by itself while Ctrl is held after a pan gesture.
      if (deltaY === 0) return;
      const direction = deltaY > 0 ? 1 : -1;
      let newZoomSec = zoomSec * (direction > 0 ? zoomFactor : 1 / zoomFactor);
      newZoomSec = Math.max(MIN_ZOOM_SEC, Math.min(newZoomSec, duration ? duration * 1.4 : 86400));
      const newPixelsPerSecond = containerWidth / newZoomSec;
      let newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;
      const maxScroll = computeMaxScroll(duration, newPixelsPerSecond, containerWidth);
      newScrollLeft = clamp(newScrollLeft, 0, maxScroll);
      // Write zoom and scroll together: the rAF draw reads both live, and a pair
      // from different zoom levels resolves to the wrong region for that frame.
      // onZoomChange only reaches us as a prop on a later commit.
      pixelsPerSecondRef.current = newPixelsPerSecond;
      zoomSecRef.current = newZoomSec;
      setScroll(newScrollLeft, 'zoom');
      onZoomChange(newZoomSec);
    } else {
      // While locked-to-playhead and playing, the auto-scroll effect below
      // recenters on every playback tick and would immediately undo a manual
      // pan anyway. Applying it regardless still publishes the transient
      // scroll through the viewport store, which the buzzdetect panel's
      // independent rAF loop can catch and draw before auto-scroll corrects
      // it — a visible jiggle there even though the spectrogram itself never
      // appears to move. Skip the pan outright so nothing transient publishes.
      if (playheadLocked && isPlaying) return;
      const panAmount = deltaY + deltaX;
      const maxScroll = computeMaxScroll(duration, pixelsPerSecond, containerWidth);
      lastManualScrollRef.current = Date.now();
      setScroll(clamp(scrollLeftRef.current + panAmount, 0, maxScroll), 'wheel');
    }
  }, [zoomSec, scrollLeft, duration, pixelsPerSecond, containerWidth, onZoomChange, playheadLocked, isPlaying]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    applyWheel(e.deltaX, e.deltaY, e.ctrlKey, e.metaKey, e.clientX);
  };

  const zoomToRange = useCallback((startTime: number, endTime: number) => {
    if (!containerRef.current) return;
    // Same width source as applyWheel and the resize handler — see containerWidth.
    const newZoomSec = Math.max(MIN_ZOOM_SEC, endTime - startTime);
    const newPps = containerWidth / newZoomSec;
    const maxScroll = computeMaxScroll(duration, newPps, containerWidth);
    // See applyWheel: zoom and scroll must reach the live refs together.
    pixelsPerSecondRef.current = newPps;
    zoomSecRef.current = newZoomSec;
    setScroll(clamp(startTime * newPps, 0, maxScroll), 'zoomToRange');
    onZoomChange(newZoomSec);
  }, [duration, containerWidth, onZoomChange, setScroll]);

  const zoomIn = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    applyWheel(0, -100, true, false, rect.left + rect.width / 2);
  }, [applyWheel]);

  const zoomOut = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    applyWheel(0, 100, true, false, rect.left + rect.width / 2);
  }, [applyWheel]);

  useImperativeHandle(ref, () => ({
    goToPrevAnnotation,
    goToNextAnnotation,
    goToTrackStart,
    goToTrackEnd,
    scrollToTime,
    revealTime,
    commitSpan,
    recenterPlayhead,
    zoomToRange,
    applyWheel,
    zoomIn,
    zoomOut,
    focusAnnotationInput: (id: string) => {
      setEditingInputId(id);
      setPencilClickedId(id);
    },
  }), [goToPrevAnnotation, goToNextAnnotation, goToTrackStart, goToTrackEnd, scrollToTime, revealTime, commitSpan, recenterPlayhead, zoomToRange, applyWheel, zoomIn, zoomOut]);

  const layeredAnnotations = useMemo(() => calculateAnnotationLayers(annotations), [annotations]);

  return (
    <div className="flex w-full h-full bg-slate-900 overflow-hidden select-none">
      {/* Y-axis canvas — separate element to the left of the spectrogram, never layered on top */}
      <canvas ref={yAxisCanvasRef} className="h-full flex-shrink-0 pointer-events-none" style={{ width: Y_AXIS_WIDTH }} />

      {/* Spectrogram area — all interactive content lives here */}
      <div
          ref={containerRef}
          className="relative flex-1 h-full overflow-hidden cursor-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setCursorPos(null);
            // Don't terminate the drag — window mouseup handler cleans up when the button is released.
            // Only end non-drag interactions (e.g. right-click pan) on leave.
            if (!isAnyDragActiveRef.current) handleMouseUp();
          }}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
      >
      {/* Build-in-progress veil — rendered BEHIND the spectrogram canvas so it
          shows through only on columns that have no chunk data yet (the canvas
          leaves those transparent via colMask). Built chunks are opaque and fully
          occlude the sweep. Suppressed during initial decode. */}
      {isBuilding && !isProcessing && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <style>{`@keyframes spectroBuildSweep { 0% { transform: translateY(-100%); } 100% { transform: translateY(200%); } }`}</style>
          <div
            className="absolute inset-x-0"
            style={{
              height: '40%',
              background: 'linear-gradient(180deg, transparent 0%, rgba(230,81,97,0.30) 45%, rgba(230,81,97,0.50) 50%, rgba(230,81,97,0.30) 55%, transparent 100%)',
              animation: 'spectroBuildSweep 1.6s linear infinite',
            }}
          />
        </div>
      )}

      {/* Layer 1: spectrogram canvas — above the veil, transparent on unbuilt columns */}
      <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />

      {/* Blurred placeholder overlay during initial spectrogram generation (decode phase) */}
      {isProcessing && (
        <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              background: 'repeating-linear-gradient(180deg, rgba(71,85,105,0.35) 0px, rgba(30,41,59,0.2) 6px, rgba(51,65,85,0.3) 6px, rgba(15,23,42,0.15) 14px)',
              filter: 'blur(6px)',
              transform: 'scale(1.06)',
            }}
          />
          <div className="absolute inset-0 bg-slate-900/60" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-slate-400 text-xs bg-slate-900/70 px-3 py-1 rounded tracking-wide">{spectrogramView.generating}</span>
          </div>
        </div>
      )}

      {/* Band-pass filter darkening canvas — below annotation HTML divs (z-5 < z-10/20)
          so filter darkening never dims annotation labels. */}
      <canvas
        ref={filterOverlayCanvasRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{ zIndex: 5 }}
      />

      {/* Layer 2: annotation HTML divs and selection handles */}
      <div className="absolute top-0 left-0 w-full h-full">
         <AnnotationOverlay
           layeredAnnotations={layeredAnnotations}
           annotations={annotations}
           selectedAnnotationId={selectedAnnotationId}
           boundAnnotationId={boundAnnotationId}
           hoveredAnnotationId={hoveredAnnotationId}
           editingInputId={editingInputId}
           annotationTools={annotationTools}
           selection={selection}
           settings={settings}
           scrollLeft={scrollLeft}
           pixelsPerSecond={pixelsPerSecond}
           containerWidth={containerRef.current?.clientWidth || 1000}
           hideLabels={hideLabels}
           currentTimeStore={currentTimeStore}
           inputRefs={inputRefs}
           pendingAnnotationsRef={pendingAnnotationsRef}
           clickDownRef={clickDownRef}
           playheadFollowsAnnotationStartRef={playheadFollowsAnnotationStartRef}
           getPointerTime={getPointerTime}
           onSelectAnnotation={onSelectAnnotation}
           onAnnotationsChange={onAnnotationsChange}
           onAnnotationsCommit={onAnnotationsCommit}
           onBoundAnnotationChange={onBoundAnnotationChange}
           onSelectionChange={onSelectionChange}
           onAnnotationMouseEnter={handleAnnotationMouseEnter}
           onAnnotationMouseLeave={handleAnnotationMouseLeave}
           setEditingInputId={setEditingInputId}
           setPencilClickedId={setPencilClickedId}
           setResizingAnnotation={setResizingAnnotation}
         />

         {/* Selection region handles */}
         <SelectionHandles
           selection={selection}
           creatingSelection={creatingSelection}
           scrollLeft={scrollLeft}
           pixelsPerSecond={pixelsPerSecond}
           containerWidth={containerRef.current?.clientWidth ?? 1000}
           onBeginResize={setResizingSelectionHandle}
         />

         {/* Band-pass filter cutoff handles */}
         <FilterHandles
           bandPassFilter={bandPassFilter}
           creatingFilter={creatingFilter}
           settings={settings}
           containerHeight={containerRef.current?.clientHeight ?? 0}
           onBeginResize={setResizingFilterEdge}
         />
      </div>

      {/* Layer 3: overlay canvas — playhead, time ruler, ident, selection darkening.
          z-30 keeps it above annotation HTML divs (z-10/20) and below nav buttons (z-50). */}
      <canvas
        ref={overlayCanvasRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{ zIndex: 30 }}
      />

      {/* ToolCursor — z-40, above overlay canvas. A single bar whose
          orientation reflects the topmost tool: vertical for Select /
          annotation tools (time-axis drags), horizontal for the filter tool
          (frequency-axis drags). High-contrast white fill with 1px dark
          outline for readability over bright spectrogram regions. */}
      {cursorPos && !suppressCustomCursor && (() => {
        const isFilter = topTool === 'filterTool';
        const w = isFilter ? 24 : 2;
        const h = isFilter ? 2 : 24;
        return (
          <div
            className="absolute pointer-events-none"
            style={{ left: cursorPos.x, top: cursorPos.y, zIndex: 40, transform: 'translate(-50%, -50%)' }}
          >
            <div
              style={{
                width: w,
                height: h,
                background: 'white',
                outline: '1px solid rgba(0,0,0,0.85)',
                outlineOffset: 0,
              }}
            />
            {/* Tool name — only shown when an annotation tool is active. */}
            {!isFilter && activeAnnotationTool && (
              <div
                className="absolute whitespace-nowrap text-[10px] leading-none font-medium"
                style={{
                  // Sit below the 24px cursor bar (bottom at +12 from centre) plus ~0.75ch
                  // of breathing room so the vertical cursor and the label never overlap.
                  top: 24,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  color: activeAnnotationTool.color,
                  textShadow: '0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)',
                }}
              >
                {activeAnnotationTool.key === '0' ? 'Custom' : activeAnnotationTool.text}
              </div>
            )}
          </div>
        );
      })()}

      </div>{/* end spectrogram area */}
      {contextMenuPos && (
        <ContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          onClose={() => setContextMenuPos(null)}
          items={[
            {
              label: spectrogramView.exportSelectionLabel,
              disabled: !selection || !onExportSelection,
              onSelect: () => onExportSelection?.(),
            },
          ]}
        />
      )}
    </div>
  );
});

Spectrogram.displayName = 'Spectrogram';

export default Spectrogram;
