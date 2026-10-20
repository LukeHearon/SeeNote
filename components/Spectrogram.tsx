import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Annotation, AnnotationWithLayer, SpectrogramSettings, AnnotationTool, Selection, BandPassFilter, VideoMode } from '../types';
import { bandExtentY } from '../utils/audioProcessing';
import { previewLayerIndex } from '../utils/previewLayer';
import { calculateAnnotationLayers } from '../utils/helpers';
import type { DateTimeFormat } from '../utils/datetimeDisplay';
import type { TimeDisplayUnit } from '../utils/helpers';
import { spanBetween } from '../utils/selectionExtend';
import { timeToX, centerScrollLeft, reconcileZoomProp } from '../utils/viewportTransform';
import { syncCanvasBitmap, onDprChange } from '../utils/canvasDpr';
import {
  Timeline,
  identityTimeline,
  minSegmentDuration,
  segmentJoins,
} from '../utils/subsetTimeline';
import { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';
import { Y_AXIS_WIDTH, DEFAULT_DATE_TIME_FORMAT } from '../constants';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import SelectionHandles from './spectrogram/SelectionHandles';
import AnnotationResizeLine from './spectrogram/AnnotationResizeLine';
import FilterHandles from './spectrogram/FilterHandles';
import AnnotationOverlay from './spectrogram/AnnotationOverlay';
import FrequencyAxisInputs from './spectrogram/FrequencyAxisInputs';
import { paintGutter, paintFrequencyTicks, paintSubsetJoins } from './spectrogram/canvasPainters';
import { paintSelectionShade, paintAnnotationPreview, paintPlayhead, paintTimeRuler, paintIdent, paintFilterBand } from './spectrogram/overlayPainter';
import { createScrollSyncHub } from '../utils/scrollSyncHub';
import { useChunkRenderer } from '../hooks/useChunkRenderer';
import { useSpectrogramInteraction } from '../hooks/useSpectrogramInteraction';
import { useAnnotationJumps } from '../hooks/useAnnotationJumps';
import { useSpectrogramZoomPan } from '../hooks/useSpectrogramZoomPan';
import { DIAG_SCROLL, diag } from '../utils/scrollDiag';
import { useAltHeld } from '../hooks/useAltHeld';
import { spectrogramView } from '../copy/ui';
import ContextMenu from './ContextMenu';

interface SpectrogramProps {
  chunkCache: MultiTierSpectrogramCache | null;
  sampleRate: number;
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
  /** Partial settings update from the axis-docked frequency boxes; merged by the caller. */
  onSettingsChange: (patch: Partial<SpectrogramSettings>) => void;
  zoomSec: number;
  annotations: Annotation[];
  /**
   * Maps one of `annotations` (display time) back to source time. Used where
   * the bounds are reported to the user, which must always be file time.
   * Defaults to the identity, i.e. no subset.
   */
  annotationToSource?: (annotation: Annotation) => Annotation;
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
  /**
   * Time at the left edge to open on, read once at mount. A spectrogram moved
   * between windows (popping out/in) is a new instance in a box of another
   * width, and this keeps it on the stretch of the file the old one was showing.
   */
  initialLeftEdgeTime?: number;
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
  // Annotation label context menu's "Bind to hotkey" action: binds the
  // label's existing tool, or creates a new one, to the next free hotkey.
  onCreateTool: (text: string, color: string, key?: string | null, description?: string) => void;
  onBindHotkey: (toolId: string, key: string) => void;
  onListenExample: (toolId: string) => void;
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


// The scroll clamp (40%-of-viewport overrun past the end) lives in
// utils/viewportTransform as `maxScroll`, imported here as `computeMaxScroll`
// so auto-pan, right-drag pan, wheel zoom/pan, and the recenter action all
// share one source of truth.

const Spectrogram = forwardRef<SpectrogramHandle, SpectrogramProps>(({
  chunkCache,
  sampleRate,
  currentTimeStore,
  duration,
  timeline,
  isPlaying,
  isProcessing,
  ident,
  settings,
  onSettingsChange,
  zoomSec,
  annotations,
  annotationToSource,
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
  initialLeftEdgeTime,
  videoMode,
  isAudioTrack = false,
  playheadLocked = false,
  hideLabels = false,
  trackStartDate = null,
  timeDisplayUnit = 'seconds',
  dateTimeFormat = DEFAULT_DATE_TIME_FORMAT,
  onExportSelection,
  onCreateTool,
  onBindHotkey,
  onListenExample,
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

  // Internal scroll position (in pixels). Ref only — there is deliberately no
  // React state mirroring it. Mirroring meant a commit of this whole subtree on
  // every scroll write, i.e. once per frame throughout playback and panning;
  // every consumer either reads the ref live at draw/event time or is driven
  // from the rAF loop below, so no render ever needed the value.
  const scrollLeftRef = useRef(0);
  // scrollLeftRef is the source of truth, written synchronously by setScroll.
  // There must be NO backward state→ref sync:
  // React commits from different tasks (wheel vs ResizeObserver) can land out
  // of order, and syncing the ref from a stale commit regresses it — the
  // resize handler then re-derives scroll from the regressed ref and re-queues
  // the stale value, producing a self-sustaining two-position oscillation
  // (the "violent jitter" bug). Every scroll write must go through setScroll.
  const setScroll = useCallback((v: number, _source: string = '?') => {
    if (DIAG_SCROLL && Math.abs(v - scrollLeftRef.current) > 0.0001) {
      if (DIAG_SCROLL) diag(`write  ${_source.padEnd(18)} ${scrollLeftRef.current.toFixed(2)} -> ${v.toFixed(2)}  (d=${(v - scrollLeftRef.current).toFixed(3)})  ppsRef=${pixelsPerSecondRef.current.toFixed(6)} zoomRef=${zoomSecRef.current}`);
    }
    scrollLeftRef.current = v;
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
  // Per-frame scroll sync for the HTML overlay layers (annotation boxes,
  // selection handles). They register here and the rAF loop below drives them
  // with the live scroll, in the same frame as the canvas draws — see
  // `utils/scrollSyncHub.ts`.
  const scrollSyncRef = useRef(createScrollSyncHub());
  // Timestamp (ms) of the last user-initiated scroll. Used to suppress auto-scroll
  // for a brief window after manual panning so the two don't fight each other.
  const lastManualScrollRef = useRef(0);

  // Custom cursor position (relative to the spectrogram container)
  // The tool cursor follows the pointer by direct style writes, not React state:
  // a state update per mousemove re-rendered the whole spectrogram. It hides
  // over elements that show their own cursor (handles, buttons), decided when
  // the pointer enters an element rather than on every move.
  const toolCursorRef = useRef<HTMLDivElement>(null);
  const toolCursorStateRef = useRef({ inside: false, suppressed: false });
  const applyToolCursorVisibility = () => {
    const el = toolCursorRef.current;
    const st = toolCursorStateRef.current;
    if (el) el.style.display = st.inside && !st.suppressed ? 'block' : 'none';
  };
  const moveToolCursor = (e: React.MouseEvent) => {
    const el = toolCursorRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!el || !rect) return;
    el.style.left = `${e.clientX - rect.left}px`;
    el.style.top = `${e.clientY - rect.top}px`;
    toolCursorStateRef.current.inside = true;
    applyToolCursorVisibility();
  };

  // Hovered annotation id for hover effects (delete button, pencil icon)
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for input focus (pencil icon click)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pencilClickedId, setPencilClickedId] = useState<string | null>(null);
  // Tracks which annotation is currently in text-edit mode (only via pencil)
  const [editingInputId, setEditingInputId] = useState<string | null>(null);

  // Open one annotation's inline label editor and put the caret in it. Shared
  // by the imperative handle, the pencil button, and the Alt-drag creation of
  // an unnamed Custom annotation.
  const focusAnnotationInput = useCallback((id: string) => {
    setEditingInputId(id);
    setPencilClickedId(id);
  }, []);

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
  // The annotations' layer assignment as of the last render, for the overlay's
  // annotation-box preview.
  const layeredAnnotationsRef = useRef<AnnotationWithLayer[]>([]);
  const drawRef = useRef<() => void>(() => {});
  const drawYAxisRef = useRef<() => void>(() => {});
  // The frequency gutter is a function of the frequency settings and the
  // container height alone — nothing the playhead or the scroll does touches
  // it. Its own dirty flag keeps it out of the per-frame path, where it used to
  // ride along with the spectrogram background and redraw its ticks and labels
  // 60 times a second to produce the same pixels.
  const yAxisDirtyRef = useRef(true);

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
  // State (not a clientHeight read during render) so a height-only resize
  // re-renders the filter handles at the new frequency positions.
  const [containerHeight, setContainerHeight] = useState(0);
  // Live mirror, read from the rAF loop (which publishes the viewport) and by
  // the scroll diagnostics.
  const containerWidthRef = useRef(0);
  containerWidthRef.current = containerWidth;
  // Last width the ResizeObserver reported, so a notification that carries no
  // actual size change can skip the scroll rescale entirely.
  const lastObservedWidthRef = useRef(0);
  const initialLeftEdgeRef = useRef<number | null>(initialLeftEdgeTime ?? null);
  // The container's CSS box, cached from the ResizeObserver. Every draw sizes
  // its own canvas bitmap from this at the CURRENT dpr (see utils/canvasDpr),
  // so a dpr change that leaves the box alone can't leave a bitmap behind.
  // Cached rather than read live because the draws run inside a rAF loop, where
  // a layout read costs a forced reflow every frame.
  const containerSizeRef = useRef({ width: 0, height: 0 });

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
  //
  // "Actually changed" is not enough on its own, though: the prop can arrive
  // carrying a zoom WE published several steps ago — a late commit of a value
  // the refs have long since moved past. See `reconcileZoomProp`, which owns
  // that rule (and the reasoning) and is unit-tested.
  const prevZoomInputsRef = useRef({ zoomSec: -1, containerWidth: -1 });
  const lastPublishedZoomRef = useRef<number | null>(null);
  if (prevZoomInputsRef.current.zoomSec !== zoomSec ||
      prevZoomInputsRef.current.containerWidth !== containerWidth) {
    if (DIAG_SCROLL) diag(`zoomin prop zoomSec ${prevZoomInputsRef.current.zoomSec} -> ${zoomSec}${zoomSec === lastPublishedZoomRef.current ? ' (own echo, ignored)' : ''}, containerWidth ${prevZoomInputsRef.current.containerWidth} -> ${containerWidth}; ppsRef ${pixelsPerSecondRef.current.toFixed(6)} -> ${pixelsPerSecond.toFixed(6)}`);
    prevZoomInputsRef.current = { zoomSec, containerWidth };
    // The observer's own last width wins over the (equally late-committable)
    // state mirror.
    const next = reconcileZoomProp(
      zoomSec,
      lastObservedWidthRef.current || containerWidth,
      { zoomSec: zoomSecRef.current, pixelsPerSecond: pixelsPerSecondRef.current },
      lastPublishedZoomRef.current,
    );
    zoomSecRef.current = next.zoomSec;
    pixelsPerSecondRef.current = next.pixelsPerSecond;
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
  } = useSpectrogramInteraction({
    containerRef,
    scrollLeftRef,
    pixelsPerSecondRef,
    durationRef,
    setScroll,
    timelineRef,
    annotations,
    selection,
    boundAnnotationId,
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
    onEditAnnotationText: focusAnnotationInput,
    onBandPassFilterChange,
    onBandPassFilterDrawn,
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

  // Publish the time→pixel transform. Driven from the rAF loop below rather
  // than from an effect on the values, because scroll no longer passes through
  // React: the loop reads the same live refs the draws do, so a consumer gets
  // the transform in the frame it applies to. The store dedupes, so publishing
  // every frame costs one comparison while the view is still, and a consumer
  // that mounts later (a panel toggled on) picks the current viewport up on the
  // next frame.
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  // Zoom publishing (see the rAF loop). The zoom itself lands in the refs on
  // every wheel event — the canvas has to be right that frame — but telling the
  // parent, which owns `zoomSec`, is coalesced to once per frame during a
  // gesture that fires faster than that.
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  // Single exit for "tell the parent the zoom changed". Records the value so the
  // render-body guard above can recognise the resulting prop as our own echo
  // (which may commit arbitrarily late) rather than as an external zoom change.
  const publishZoom = useCallback((z: number) => {
    lastPublishedZoomRef.current = z;
    onZoomChangeRef.current(z);
  }, []);
  const pendingZoomPublishRef = useRef(false);
  const lastZoomEventRef = useRef(0);
  const publishedViewportRef = useRef({ scrollLeft: -1, pixelsPerSecond: -1, containerWidth: -1 });

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
  // and we run the identical centering check imperatively. setScroll writes a ref
  // and marks the layers dirty, so a centering step triggers no React render at
  // all — never mind the whole-tree per-tick render we used to pay.
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
          // From the ResizeObserver's cached box, never `clientWidth`: this runs
          // on every media-clock tick, and a live layout read there costs a
          // forced reflow per tick (~6% of all JS in the 89s profile — see
          // local/profile/FINDINGS.md). The cache is fractional where
          // clientWidth is integer-rounded, which is only safe because the width
          // is used for centering and the fits-on-screen guard below, never to
          // derive pixelsPerSecond. Falls back to the live read before the
          // observer has reported once.
          const containerWidth = containerSizeRef.current.width || containerRef.current.clientWidth;
          const pps = pixelsPerSecondRef.current;
          if (duration * pps <= containerWidth) return;
          setScroll(centerScrollLeft(t, pps, containerWidth, duration), 'autoScroll');
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
    onChunkArrived: () => { drawDirtyRef.current = true; },
    scrollLeftRef,
    pixelsPerSecondRef,
    pixelsPerSecond,
    duration,
    timeline: activeTimeline,
    settings,
    isProcessing,
    canvasRef,
    containerSizeRef,
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

    // Size the bitmap and take the dpr in one step, from the container's cached
    // CSS box: the box (not canvas.width/dpr) is what keeps tick positions from
    // fluctuating by a physical pixel during playback.
    const { dpr, width, height } = syncCanvasBitmap(
      canvas, containerSizeRef.current.width, containerSizeRef.current.height);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const scrollLeft_live = scrollLeftRef.current;
    const pixelsPerSecond_live = pixelsPerSecondRef.current || pixelsPerSecond;
    const startTime = scrollLeft_live / pixelsPerSecond_live;
    const timePerPixel = 1 / pixelsPerSecond_live;
    const endTime = startTime + (width * timePerPixel);
    const toX = (t: number) => timeToX(t, scrollLeft_live, pixelsPerSecond_live);

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
      const band = bandPassFilter
        ? bandExtentY(bandPassFilter, height, settings.minFreq, settings.maxFreq, settings.frequencyScale)
        : null;
      paintSelectionShade(ctx, toX(activeSelection.start), toX(activeSelection.end), width, height, band);
    }

    // 1a-ii. Preview of the annotation box this span will become — mouse-drag,
    // keyboard sweep, and a settled Shift+Arrow selection all reach here the
    // same way (see `previewingAnnotationLabel` above). Drawn on top of the
    // shading/spine already drawn for it above, in the same pass so it never
    // lags a frame behind during a live sweep. Same geometry/colors as the
    // real committed box (AnnotationOverlay) — border, background, rounded
    // corners, height, and vertical stacking layer — just not interactive.
    if (previewingAnnotationLabel && activeAnnotationTool) {
      // Same layer the committed box would get, without re-layering every
      // annotation each frame of a sweep (see previewLayerIndex).
      paintAnnotationPreview(
        ctx, toX(activeSelection!.start), toX(activeSelection!.end), width,
        previewLayerIndex(layeredAnnotationsRef.current, activeSelection!.start), activeAnnotationTool,
      );
    }

    // 1b. Draw subset segment joins — the seams where the display axis skips
    // from the end of one kept span to the start of the next. Dashed and
    // distinct from the playhead/ruler so a cut reads as a splice, not a marker.
    paintSubsetJoins(ctx, subsetJoins, minSegmentSec, scrollLeft_live, pixelsPerSecond_live, width, height);

    paintPlayhead(ctx, toX(currentTime), width, height);

    paintTimeRuler(ctx, {
      width, height, scrollLeft: scrollLeft_live, pixelsPerSecond: pixelsPerSecond_live,
      // Tick spacing from the stable configured pixelsPerSecond (derived from
      // zoomSec), NOT the live one, which fluctuates by sub-pixel amounts during
      // playback/panning and at round zoom levels can flip the chosen step —
      // making labels flicker in and out.
      stepPixelsPerSecond: pixelsPerSecond,
      startTime, endTime, duration, zoomSec,
      timeline: timelineRef.current, timeDisplayUnit, trackStartDate, dateTimeFormat,
    });

    if (ident) paintIdent(ctx, ident);

    ctx.restore();
  // activeTimeline is read through its ref at draw time, but it's a dep as well
  // so a timeline swap repaints the ruler (whose labels come from it).
  }, [pixelsPerSecond, zoomSec, currentTimeStore, ident, selection, creatingSelection, creatingAnnotation, boundAnnotationId, annotations, sweepStart, duration, subsetJoins, minSegmentSec, activeTimeline, trackStartDate, timeDisplayUnit, dateTimeFormat, activeAnnotationTool, bandPassFilter, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Band-pass filter darkening canvas: renders BELOW the annotation HTML divs
  // (unlike the overlay canvas above) so filter darkening never dims annotation
  // labels — labels must stay full brightness/color regardless of filter state.
  const drawFilterOverlay = useCallback(() => {
    const canvas = filterOverlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { dpr, width, height } = syncCanvasBitmap(
      canvas, containerSizeRef.current.width, containerSizeRef.current.height);

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
    // Mixed mode outside a selection: the filter will apply again once there is
    // one, so its edges stay visible.
    const dormant = !isAudioTrack && videoMode === 'mixed' && !selection;
    if (filterBand) paintFilterBand(ctx, filterBand, width, height, !filterInactive ? 'active' : dormant ? 'dormant' : 'hidden');

    ctx.restore();
  }, [creatingFilter, bandPassFilter, videoMode, isAudioTrack, selection, settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Y-axis canvas: draws the frequency axis. Separate from the spectrogram area so it is never layered on top.
  const drawYAxis = useCallback(() => {
    const canvas = yAxisCanvasRef.current;
    if (!canvas) return;
    // The min/max frequency boxes (FrequencyAxisInputs) are docked over the top
    // and bottom of the gutter and already show the endpoint values, so the
    // canvas skips any tick that would land under them.
    paintGutter(canvas, containerSizeRef.current.height, 'spectrogram', (ctx, width, height) =>
      paintFrequencyTicks(ctx, width, height, settings, 24));
  }, [settings.minFreq, settings.maxFreq, settings.frequencyScale]);

  // Keep drawRef/drawYAxisRef current and mark dirty whenever the spectrogram
  // background needs a redraw (scroll, zoom, data, settings changed).
  // useLayoutEffect so the flag is set before the useEffect below can read it.
  useLayoutEffect(() => {
    drawRef.current = draw;
    drawDirtyRef.current = true;
  }, [draw]);

  useLayoutEffect(() => {
    drawYAxisRef.current = drawYAxis;
    yAxisDirtyRef.current = true;
  }, [drawYAxis]);

  // The overlay (playhead/selection/ruler) must animate every frame during
  // playback, but playback time no longer flows through React state — so we can't
  // rely on a per-render effect to reschedule the frame. Instead a single
  // self-scheduling rAF loop runs for the component's lifetime and repaints each
  // layer only when its dirty flag is set:
  //   • drawDirty  — expensive spectrogram background (scroll/zoom/data/settings)
  //   • yAxisDirty — the frequency gutter (frequency settings, resize)
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

  // NOTE: there is deliberately no "mark the background dirty on every media
  // clock tick while playing" subscription here. There used to be, from before
  // setScroll marked the layers itself. It is redundant now — auto-scroll moves
  // the view through setScroll, which dirties every layer synchronously, and new
  // chunk data changes `draw`'s identity, which dirties it through the effect
  // above. What the subscription did do was repaint the full-size background
  // canvas ~50 times a second during playback with the view standing still
  // (playhead unlocked), producing identical pixels: in the `_5` profile the two
  // full-canvas layers together accounted for 2.1 paints per rendered frame and
  // 71% of every pixel painted. The playhead lives on the overlay canvas and
  // still ticks at 50Hz; only the background stopped repainting for nothing.

  useEffect(() => {
    const tick = () => {
      if (drawDirtyRef.current) {
        drawRef.current();
        drawDirtyRef.current = false;
      }
      if (yAxisDirtyRef.current) {
        drawYAxisRef.current();
        yAxisDirtyRef.current = false;
      }
      if (overlayDirtyRef.current) {
        drawOverlayRef.current();
        overlayDirtyRef.current = false;
      }
      if (filterOverlayDirtyRef.current) {
        drawFilterOverlayRef.current();
        filterOverlayDirtyRef.current = false;
      }
      // Annotation boxes and selection handles are HTML, not canvas, but they
      // move on this same clock: one transform per layer, in the same frame as
      // the draws above, so they can't lag the spectrogram they annotate. Cheap
      // and self-gating — each layer returns immediately when scroll is unchanged.
      scrollSyncRef.current.run(scrollLeftRef.current);
      // One zoom publish per frame at most, after this frame's draws and layer
      // syncs have already used the live refs — see applyWheel. A gesture that
      // outruns the frame rate collapses to a single parent render per frame.
      if (pendingZoomPublishRef.current) {
        pendingZoomPublishRef.current = false;
        publishZoom(zoomSecRef.current);
      }
      // Compared here rather than leaning on the store's own dedupe, so a still
      // view doesn't allocate a viewport object every frame just to have it
      // discarded.
      const pub = publishedViewportRef.current;
      if (scrollLeftRef.current !== pub.scrollLeft ||
          pixelsPerSecondRef.current !== pub.pixelsPerSecond ||
          containerWidthRef.current !== pub.containerWidth) {
        pub.scrollLeft = scrollLeftRef.current;
        pub.pixelsPerSecond = pixelsPerSecondRef.current;
        pub.containerWidth = containerWidthRef.current;
        onViewportChangeRef.current?.({ ...pub });
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
      if (DIAG_SCROLL) diag(`beat   scroll=${now.toFixed(2)} (moved ${(now - last).toFixed(3)}) t0=${(now / (pixelsPerSecondRef.current || 1)).toFixed(4)}s pps=${pixelsPerSecondRef.current.toFixed(6)} zoomRef=${zoomSecRef.current} clientWidth=${containerRef.current?.clientWidth} playing=${isPlayingRef.current} dragging=${isAnyDragActiveRef.current}`);
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
        const newHeight = Math.max(1, height);
        // A notification carrying the size we already have has nothing to do,
        // and doing it anyway is not free: the four synchronous redraws below
        // include a full spectrogram rebuild. In the `_6` profile this callback
        // was 1118ms of the 8160ms sampled, nearly all of it inside
        // useChunkRenderer's draw. ResizeObserver does deliver duplicates, and
        // a drag-resize delivers a stream of them. A dpr change leaves the CSS
        // box alone and is handled by its own effect below, so nothing that
        // needs a repaint is lost by returning here.
        if (newWidth === containerSizeRef.current.width &&
            newHeight === containerSizeRef.current.height) return;
        if (DIAG_SCROLL) diag(`resize contentRect.width=${width} clientWidth=${containerRef.current?.clientWidth} stateWidth=${containerWidthRef.current} ppsRef=${pixelsPerSecondRef.current.toFixed(6)} newPps=${(newWidth / zoomSecRef.current).toFixed(6)}`);
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
        if (initialLeftEdgeRef.current !== null && zoomSecRef.current > 0) {
          const newPps = newWidth / zoomSecRef.current;
          pixelsPerSecondRef.current = newPps;
          setScroll(initialLeftEdgeRef.current * newPps, 'resize');
          initialLeftEdgeRef.current = null;
        } else if (pixelsPerSecondRef.current > 0 && zoomSecRef.current > 0 && newWidth !== lastObservedWidthRef.current) {
          const leftEdgeTime = scrollLeftRef.current / pixelsPerSecondRef.current;
          const newPps = newWidth / zoomSecRef.current;
          const newScrollLeft = leftEdgeTime * newPps;
          // The zoom ref moves in the same step as the scroll it was rescaled
          // for. Left for the render to update, every draw between here and the
          // commit — including the synchronous ones just below — paired the new
          // scroll with the old pps, so a drag-resize showed a different region
          // of the file on every notification until it stopped. The render's
          // reconcileZoomProp derives this same value (width / zoomSec).
          pixelsPerSecondRef.current = newPps;
          setScroll(newScrollLeft, 'resize');
        }
        lastObservedWidthRef.current = newWidth;
        setContainerWidth(newWidth);
        setContainerHeight(newHeight);
        // Publish the new box; each draw sizes its own bitmap from it. Repaint
        // every layer immediately rather than waiting a frame for the rAF loop's
        // dirty flags — a resized bitmap comes back cleared.
        containerSizeRef.current = { width: newWidth, height: newHeight };
        drawRef.current();
        drawOverlayRef.current();
        drawFilterOverlayRef.current();
        drawYAxisRef.current();
        // Just drawn with the new geometry: the flags setScroll raised would
        // otherwise repaint all four again on the next frame.
        drawDirtyRef.current = false;
        overlayDirtyRef.current = false;
        filterOverlayDirtyRef.current = false;
        yAxisDirtyRef.current = false;
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, []);

  // A dpr change (webview zoom step, a drag onto a display with a different
  // scale factor) leaves the CSS box alone, so the ResizeObserver above never
  // fires for it. Repaint explicitly: the draws re-size their bitmaps to the new
  // ratio, which is what keeps the fixed-px axis labels at their intended size.
  useEffect(() => onDprChange(() => {
    drawRef.current();
    drawOverlayRef.current();
    drawFilterOverlayRef.current();
    drawYAxisRef.current();
  }), []);

  // --- Annotation navigation ---
  const { goToPrevAnnotation, goToNextAnnotation, goToTrackStart, goToTrackEnd } = useAnnotationJumps({
    annotations, subsetJoins, selection, duration, currentTimeStore,
    containerRef, containerSizeRef, pixelsPerSecondRef, durationRef, setScroll,
    onSeek, onSelectionChange, onBoundAnnotationChange,
  });

  const { scrollToTime, revealTime, recenterPlayhead, applyWheel, zoomToRange, zoomIn, zoomOut } = useSpectrogramZoomPan({
    containerRef, containerWidth, duration, zoomSec, zoomSecRef, scrollLeftRef, pixelsPerSecondRef,
    lastZoomEventRef, pendingZoomPublishRef, lastManualScrollRef, publishZoom, setScroll,
    playheadLocked, isPlaying, currentTimeStore,
  });

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
    focusAnnotationInput,
  }), [goToPrevAnnotation, goToNextAnnotation, goToTrackStart, goToTrackEnd, scrollToTime, revealTime, commitSpan, recenterPlayhead, zoomToRange, applyWheel, zoomIn, zoomOut, focusAnnotationInput]);

  const layeredAnnotations = useMemo(() => calculateAnnotationLayers(annotations), [annotations]);
  layeredAnnotationsRef.current = layeredAnnotations;

  // Stable identity for the memoised AnnotationOverlay: getPointerTime is a plain
  // function rebuilt every render (it closes over scrollLeft), so passing it
  // directly would defeat the memo on every scroll step.
  const getPointerTimeRef = useRef(getPointerTime);
  getPointerTimeRef.current = getPointerTime;
  const stableGetPointerTime = useCallback((e: React.MouseEvent) => getPointerTimeRef.current(e), []);

  return (
    <div className="flex w-full h-full bg-slate-900 overflow-hidden select-none">
      {/* Y-axis gutter — separate element to the left of the spectrogram, never layered on top.
          The min/max frequency boxes are docked on the axis itself, at the ends of the scale they set. */}
      <div className="relative h-full flex-shrink-0" style={{ width: Y_AXIS_WIDTH }}>
        <canvas ref={yAxisCanvasRef} className="w-full h-full pointer-events-none" />
        <FrequencyAxisInputs
          minFreq={settings.minFreq}
          maxFreq={settings.maxFreq}
          sampleRate={sampleRate}
          onChange={onSettingsChange}
        />
      </div>

      {/* Spectrogram area — all interactive content lives here */}
      <div
          ref={containerRef}
          className="relative flex-1 h-full overflow-hidden cursor-none"
          onMouseDown={handleMouseDown}
          onMouseMove={e => { moveToolCursor(e); handleMouseMove(e); }}
          onMouseOver={e => {
            toolCursorStateRef.current.suppressed = window.getComputedStyle(e.target as Element).cursor !== 'none';
            applyToolCursorVisibility();
          }}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            toolCursorStateRef.current.inside = false;
            applyToolCursorVisibility();
            // Don't terminate the drag — window mouseup handler cleans up when the button is released.
            // Only end non-drag interactions (e.g. right-click pan) on leave.
            if (!isAnyDragActiveRef.current) handleMouseUp();
          }}
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
          so filter darkening never dims annotation labels.

          Mounted only when there is a band to draw. A full-viewport canvas is a
          compositing layer whether or not a single pixel of it is opaque, and
          without a filter set (the usual state) every frame was blending a
          wholly transparent one. `creatingFilter` and `bandPassFilter` are both
          deps of drawFilterOverlay, so the commit that mounts it also marks it
          dirty and the rAF loop fills it on the next frame. */}
      {(creatingFilter || bandPassFilter) && (
        <canvas
          ref={filterOverlayCanvasRef}
          className="absolute top-0 left-0 w-full h-full pointer-events-none"
          style={{ zIndex: 5 }}
        />
      )}

      {/* Layer 2: annotation HTML divs and selection handles */}
      <div className="absolute top-0 left-0 w-full h-full">
         <AnnotationOverlay
           ident={ident}
           layeredAnnotations={layeredAnnotations}
           annotations={annotations}
           annotationToSource={annotationToSource}
           selectedAnnotationId={selectedAnnotationId}
           boundAnnotationId={boundAnnotationId}
           hoveredAnnotationId={hoveredAnnotationId}
           editingInputId={editingInputId}
           annotationTools={annotationTools}
           selection={selection}
           settings={settings}
           scrollLeftRef={scrollLeftRef}
           scrollSync={scrollSyncRef.current}
           pixelsPerSecond={pixelsPerSecond}
           pixelsPerSecondRef={pixelsPerSecondRef}
           containerWidth={containerWidth}
           hideLabels={hideLabels}
           currentTimeStore={currentTimeStore}
           inputRefs={inputRefs}
           pendingAnnotationsRef={pendingAnnotationsRef}
           clickDownRef={clickDownRef}
           playheadFollowsAnnotationStartRef={playheadFollowsAnnotationStartRef}
           getPointerTime={stableGetPointerTime}
           onSelectAnnotation={onSelectAnnotation}
           onAnnotationsChange={onAnnotationsChange}
           onAnnotationsCommit={onAnnotationsCommit}
           onBoundAnnotationChange={onBoundAnnotationChange}
           onSelectionChange={onSelectionChange}
           onAnnotationMouseEnter={handleAnnotationMouseEnter}
           onAnnotationMouseLeave={handleAnnotationMouseLeave}
           setEditingInputId={setEditingInputId}
           focusAnnotationInput={focusAnnotationInput}
           setResizingAnnotation={setResizingAnnotation}
           onCreateTool={onCreateTool}
           onBindHotkey={onBindHotkey}
           onListenExample={onListenExample}
         />

         {/* Selection region handles */}
         <SelectionHandles
           selection={selection}
           creatingSelection={creatingSelection}
           scrollLeftRef={scrollLeftRef}
           scrollSync={scrollSyncRef.current}
           pixelsPerSecond={pixelsPerSecond}
           pixelsPerSecondRef={pixelsPerSecondRef}
           onBeginResize={setResizingSelectionHandle}
         />

         {/* Single boundary line for a handle being dragged on an annotation
             that isn't bound to the selection (that case already gets the
             full active-selection treatment above). */}
         <AnnotationResizeLine
           resizingAnnotation={resizingAnnotation}
           annotations={annotations}
           boundAnnotationId={boundAnnotationId}
           scrollLeftRef={scrollLeftRef}
           scrollSync={scrollSyncRef.current}
           pixelsPerSecond={pixelsPerSecond}
           pixelsPerSecondRef={pixelsPerSecondRef}
         />

         {/* Band-pass filter cutoff handles */}
         <FilterHandles
           bandPassFilter={bandPassFilter}
           creatingFilter={creatingFilter}
           settings={settings}
           containerHeight={containerHeight}
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
      {(() => {
        const isFilter = topTool === 'filterTool';
        const w = isFilter ? 24 : 2;
        const h = isFilter ? 2 : 24;
        return (
          <div
            className="absolute pointer-events-none"
            ref={toolCursorRef}
            style={{ display: 'none', zIndex: 40, transform: 'translate(-50%, -50%)' }}
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
