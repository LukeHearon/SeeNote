import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { annotationOverlay as copy } from '../../copy/ui';
import { tooltips } from '../../copy/tooltips';
import { X, Pencil, Keyboard, Copy, Volume2 } from 'lucide-react';
import { Annotation, AnnotationWithLayer, AnnotationTool, Selection, SpectrogramSettings } from '../../types';
import { annotationColorStyle, annotationBoxTop, ANNOTATION_BOX_HEIGHT } from '../../utils/helpers';
import AnnotationLabelInput from './AnnotationLabelInput';
import { computeLabelPlacement, computeButtonAnchorX } from '../../utils/viewportTransform';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { annotationMatchingTool, canBindAnnotationToHotkey, bindAnnotationToHotkey } from '../../utils/bindAnnotationHotkey';
import ContextMenu, { ContextMenuItem } from '../ContextMenu';
import type { ScrollSyncHub } from '../../utils/scrollSyncHub';
import { useScrollTransformLayer } from '../../hooks/useScrollTransformLayer';

interface AnnotationOverlayProps {
  layeredAnnotations: AnnotationWithLayer[];
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  boundAnnotationId: string | null;
  hoveredAnnotationId: string | null;
  editingInputId: string | null;
  annotationTools: AnnotationTool[];
  selection: Selection | null;
  settings: SpectrogramSettings;
  // Live scroll position (pixels). Read at render for the first paint; the
  // per-frame updates come through the hub instead — see the note below.
  scrollLeftRef: React.MutableRefObject<number>;
  // Spectrogram's rAF loop drives this once per frame with the live scroll.
  scrollSync: ScrollSyncHub;
  pixelsPerSecond: number;
  containerWidth: number;
  hideLabels: boolean;
  currentTimeStore: CurrentTimeStore;
  inputRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  // Pending-edit ref used so resize/text edits stage before commit (shared with parent).
  pendingAnnotationsRef: React.MutableRefObject<Annotation[]>;
  // Click-vs-drag tracking ref, written on annotation-center mousedown.
  clickDownRef: React.MutableRefObject<{ x: number; y: number; annotationId: string; pointerTime: number } | null>;
  // Set true at resize start when the playhead is within 0.5s of the annotation start.
  playheadFollowsAnnotationStartRef: React.MutableRefObject<boolean>;
  getPointerTime: (e: React.MouseEvent) => number;
  onSelectAnnotation: (id: string | null) => void;
  // Enter in the label editor: full deselect (clears the bound annotation and
  // its selection region too), matching the window-level Enter shortcut.
  onDeselectAnnotation?: () => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onAnnotationMouseEnter: (id: string) => void;
  onAnnotationMouseLeave: () => void;
  setEditingInputId: (id: string | null) => void;
  /** Open an annotation's label editor and put the caret in it (pencil click). */
  focusAnnotationInput: (id: string) => void;
  setResizingAnnotation: (v: { id: string; side: 'start' | 'end'; originalTime: number } | null) => void;
  // Right-click "Bind to hotkey": binds the label's existing tool, or creates
  // a new one, to the next free hotkey digit.
  onCreateTool: (text: string, color: string, key?: string | null, description?: string) => void;
  onBindHotkey: (toolId: string, key: string) => void;
  // Right-click "Listen to example": toggles the example-clip preview for the
  // tool matching this label — same action as the `E` hotkey.
  onListenExample: (toolId: string) => void;
}

interface AnnotationContextMenuState {
  annotationId: string;
  x: number;
  y: number;
}

const LABEL_INSET = 8;
// The label is clipped to the box, but the editor can't be: pinned to both
// edges of a sliver of a box it collapses to zero width, so a zoomed-out edit
// has nowhere to put the caret. Below the readable width it drops the right pin
// and takes a fixed width of its own, overhanging the box (and carrying the
// dropdown with it).
const MIN_EDITOR_WIDTH = 140;
const PENCIL_INSET = 20; // matches the removed `right-5` (1.25rem)
// The delete badge overhangs the annotation's own edge (-right-3), but when
// pinned it must stay fully inside the viewport, so the pinned inset is a
// positive margin rather than reusing the overhang value.
const DELETE_NATURAL_INSET = -12; // matches the removed `-right-3` (-0.75rem)
const DELETE_PINNED_INSET = 12;

// Which of an annotation's children need a scroll-dependent position fix-up
// each frame (see the pinning note on `syncScroll`).
type PinnedKind = 'label' | 'dropdown' | 'pencil' | 'delete';

interface AnnotationEls {
  els: Partial<Record<PinnedKind, HTMLElement>>;
  // Last values written, so a frame that changes nothing writes no styles.
  labelLeft: number;
  pencilRight: number;
  deleteRight: number;
}

interface VisibleAnnotation {
  ann: AnnotationWithLayer;
  // Content-space pixels: time * pixelsPerSecond, independent of scroll.
  startX: number;
  endX: number;
  width: number;
}

const emptyEls = (): AnnotationEls => ({ els: {}, labelLeft: NaN, pencilRight: NaN, deleteRight: NaN });

// Label placement in *screen* pixels for one annotation at a given scroll.
// Handles screen-left pinning (annotation start scrolled off the left) and the
// selection "pop": an overlapping selection pushes the label right.
const labelLeftFor = (
  v: { startX: number; endX: number },
  scrollLeft: number,
  selStartX: number | null,
  selEndX: number | null,
): number => {
  const annStartX = v.startX - scrollLeft;
  const { leftX } = computeLabelPlacement({
    annStartX,
    annEndX: v.endX - scrollLeft,
    selStartX: selStartX === null ? null : selStartX - scrollLeft,
    selEndX: selEndX === null ? null : selEndX - scrollLeft,
    inset: LABEL_INSET,
    textWidth: 0,
  });
  // Relative to the annotation div, whose origin is the annotation's start.
  return leftX - annStartX;
};

// Screen-right pinning for the edit/delete hover buttons, mirroring the label's
// screen-left pin: when the annotation's end scrolls off the right of the
// viewport, the buttons pin near the viewport's right edge instead of sitting
// off-screen past the annotation's actual end.
const buttonRightFor = (
  v: { startX: number; endX: number },
  scrollLeft: number,
  containerWidth: number,
  naturalInset: number,
  pinnedInset: number,
  minMargin: number,
): number => {
  const annStartX = v.startX - scrollLeft;
  const annEndX = v.endX - scrollLeft;
  return annEndX - computeButtonAnchorX(annStartX, annEndX, containerWidth, naturalInset, pinnedInset, minMargin);
};

// Per-annotation positioned divs: resize handles, the text input (edit mode) vs
// read-only span, pencil icon, delete button, colors and selection/bound visual
// states. Render-only — the center-drag/resize interaction state is owned by
// Spectrogram.tsx and reached via callbacks and shared refs.
//
// Scrolling does NOT go through React here. The boxes are laid out in content
// pixels (time × pixelsPerSecond) inside one wrapper div, and the wrapper is
// translated imperatively from Spectrogram's rAF loop — the same clock and the
// same frame as the canvas draws, so labels and spectrogram can't drift apart.
// Routing scroll through props instead meant the labels only moved when React
// committed a render of the whole spectrogram subtree, which on a slow machine
// lands every 2-4 frames and always after the canvas has already moved: the
// canvas glided, the labels stepped.
//
// React re-renders remain for what actually changes shape — annotations,
// selection, zoom — plus a coarse cull window (below) that only advances once
// per half-viewport of scrolling.
const AnnotationOverlay: React.FC<AnnotationOverlayProps> = ({
  layeredAnnotations,
  annotations,
  selectedAnnotationId,
  boundAnnotationId,
  hoveredAnnotationId,
  editingInputId,
  annotationTools,
  selection,
  scrollLeftRef,
  scrollSync,
  pixelsPerSecond,
  containerWidth,
  hideLabels,
  currentTimeStore,
  inputRefs,
  pendingAnnotationsRef,
  clickDownRef,
  playheadFollowsAnnotationStartRef,
  getPointerTime,
  onSelectAnnotation,
  onDeselectAnnotation,
  onAnnotationsChange,
  onAnnotationsCommit,
  onBoundAnnotationChange,
  onSelectionChange,
  onAnnotationMouseEnter,
  onAnnotationMouseLeave,
  setEditingInputId,
  focusAnnotationInput,
  setResizingAnnotation,
  onCreateTool,
  onBindHotkey,
  onListenExample,
}) => {
  const [contextMenu, setContextMenu] = useState<AnnotationContextMenuState | null>(null);

  // Cull anchor: the scroll position the currently-mounted set was chosen for.
  // Mounted range is [anchor - w, anchor + 2w], so the anchor can go stale by
  // half a viewport before the visible span could reach an edge of it. Advancing
  // it is the ONLY React render a scroll causes, and it happens roughly once per
  // half-viewport scrolled rather than once per playback tick.
  const [cullAnchor, setCullAnchor] = useState(() => scrollLeftRef.current);
  const cullAnchorRef = useRef(cullAnchor);
  cullAnchorRef.current = cullAnchor;

  const overlayWidth = containerWidth || 1000;
  const containerWidthRef = useRef(overlayWidth);
  containerWidthRef.current = overlayWidth;

  const selStartX = selection ? selection.start * pixelsPerSecond : null;
  const selEndX = selection ? selection.end * pixelsPerSecond : null;
  const selRef = useRef({ selStartX, selEndX });
  selRef.current = { selStartX, selEndX };

  const visible = useMemo<VisibleAnnotation[]>(() => {
    const rangeMin = cullAnchor - overlayWidth;
    const rangeMax = cullAnchor + 2 * overlayWidth;
    const out: VisibleAnnotation[] = [];
    for (const ann of layeredAnnotations) {
      const startX = ann.start * pixelsPerSecond;
      const endX = ann.end * pixelsPerSecond;
      if (endX < rangeMin || startX > rangeMax) continue;
      out.push({ ann, startX, endX, width: endX - startX });
    }
    return out;
  }, [layeredAnnotations, pixelsPerSecond, cullAnchor, overlayWidth]);
  // Ref mirror so the per-frame sync reads the current geometry without being
  // rebuilt. Assigned during render (like the mirrors above) so it is already
  // fresh when the layer hook's effect re-pins after this commit.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Element registry for the per-frame pin fix-ups. Ref callbacks are cached per
  // (id, kind) so a re-render doesn't detach and re-attach every node.
  const elsRef = useRef(new Map<string, AnnotationEls>());
  const refCbRef = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const elRef = useCallback((id: string, kind: PinnedKind) => {
    const key = `${id}:${kind}`;
    let cb = refCbRef.current.get(key);
    if (!cb) {
      cb = (node: HTMLElement | null) => {
        let rec = elsRef.current.get(id);
        if (!rec) { rec = emptyEls(); elsRef.current.set(id, rec); }
        if (node) rec.els[kind] = node;
        else delete rec.els[kind];
      };
      refCbRef.current.set(key, cb);
    }
    return cb;
  }, []);

  // The shared layer transform carries every box; this is the remainder — the
  // handful of elements whose placement is pinned to a viewport edge (the label's
  // screen-left pin, the hover buttons' screen-right pin), plus the cull anchor.
  // Each gets a style write only when its pinned value actually changed.
  const syncPins = useCallback((scrollLeft: number) => {
    const cw = containerWidthRef.current;
    const { selStartX: sx, selEndX: ex } = selRef.current;
    for (const v of visibleRef.current) {
      const rec = elsRef.current.get(v.ann.id);
      if (!rec) continue;
      const { label, dropdown, pencil, delete: del } = rec.els;
      const input = inputRefs.current[v.ann.id];
      if (label || dropdown || input) {
        const left = labelLeftFor(v, scrollLeft, sx, ex);
        if (left !== rec.labelLeft) {
          rec.labelLeft = left;
          const px = `${left}px`;
          if (label) label.style.left = px;
          if (input) input.style.left = px;
          if (dropdown) dropdown.style.left = px;
        }
      }
      if (pencil) {
        const right = buttonRightFor(v, scrollLeft, cw, PENCIL_INSET, PENCIL_INSET, 24);
        if (right !== rec.pencilRight) { rec.pencilRight = right; pencil.style.right = `${right}px`; }
      }
      if (del) {
        const right = buttonRightFor(v, scrollLeft, cw, DELETE_NATURAL_INSET, DELETE_PINNED_INSET, 16);
        if (right !== rec.deleteRight) { rec.deleteRight = right; del.style.right = `${right}px`; }
      }
    }

    if (Math.abs(scrollLeft - cullAnchorRef.current) > cw * 0.5) {
      cullAnchorRef.current = scrollLeft;
      setCullAnchor(scrollLeft);
    }
  }, [inputRefs]);

  const layer = useScrollTransformLayer(scrollSync, scrollLeftRef, syncPins);

  // Drop registry entries for annotations that just unmounted. No dep array:
  // the mounted set can change on any render.
  useLayoutEffect(() => {
    const live = new Set(visible.map(v => v.ann.id));
    for (const id of Array.from(elsRef.current.keys())) {
      if (!live.has(id)) elsRef.current.delete(id);
    }
    for (const key of Array.from(refCbRef.current.keys())) {
      if (!live.has(key.slice(0, key.lastIndexOf(':')))) refCbRef.current.delete(key);
    }
  });

  const contextMenuItems = (state: AnnotationContextMenuState): ContextMenuItem[] => {
    const ann = annotations.find(a => a.id === state.annotationId);
    if (!ann) return [];
    const existingTool = annotationMatchingTool(ann, annotationTools);
    return [
      {
        label: copy.contextBindHotkey,
        icon: <Keyboard size={12} />,
        disabled: !canBindAnnotationToHotkey(ann, annotationTools),
        onSelect: () => bindAnnotationToHotkey(ann, annotationTools, { onBindHotkey, onCreateTool }),
      },
      {
        label: copy.contextListenExample,
        icon: <Volume2 size={12} />,
        disabled: existingTool == null || (existingTool.exampleFiles?.length ?? 0) === 0,
        onSelect: () => {
          if (existingTool) onListenExample(existingTool.id);
        },
      },
      {
        label: copy.contextCopyAnnotation,
        icon: <Copy size={12} />,
        onSelect: () => {
          navigator.clipboard.writeText(`${ann.text} (${ann.start}, ${ann.end})`);
        },
      },
    ];
  };

  // Scroll at render time: the initial style values below are the same ones
  // syncPins would write, so the first paint of a newly-mounted box is already
  // pinned correctly (the layer's effect re-pins after the commit anyway).
  const scrollLeft = scrollLeftRef.current;

  return (
    <>
      <div
        ref={layer.ref}
        className="absolute top-0 left-0 w-full h-full"
        // The transform makes this wrapper a stacking context, so the boxes'
        // own z-indices (10 / 20) no longer compete with their former siblings.
        // z-10 restores the layer's place: above the filter darkening canvas
        // (z-5), below the playhead/ruler canvas (z-30). Selection and filter
        // handles (z-15) now sit above a *selected* box too, not just the
        // unselected ones — which also makes a handle lying over an annotation
        // grabbable again.
        style={{ ...layer.style, zIndex: 10 }}
      >
      {visible.map((v) => {
        const annotation = v.ann;
        const { startX: left, width } = v;
        const isSelected = selectedAnnotationId === annotation.id;
        const isBound = boundAnnotationId === annotation.id;

        const top = annotationBoxTop(annotation.layerIndex);

        const baseColor = annotation.color || "#ffffff";
        const isCustomAnnotation = baseColor.toLowerCase() === "#ffffff" || baseColor.toLowerCase() === "#fff";
        const styleVars = annotationColorStyle(baseColor, isSelected);

        const isHovered = hoveredAnnotationId === annotation.id;

        const labelStyle = { left: `${labelLeftFor(v, scrollLeft, selStartX, selEndX)}px`, right: `${LABEL_INSET}px` };
        const editorStyle = width > 30
            ? labelStyle
            : { left: labelStyle.left, right: 'auto', width: `${MIN_EDITOR_WIDTH}px` };

        const pencilRight = buttonRightFor(v, scrollLeft, overlayWidth, PENCIL_INSET, PENCIL_INSET, 24);
        const deleteRight = buttonRightFor(v, scrollLeft, overlayWidth, DELETE_NATURAL_INSET, DELETE_PINNED_INSET, 16);

        const deleteAnnotation = () => {
            onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
            if (isSelected) onSelectAnnotation(null);
            if (boundAnnotationId === annotation.id) {
                onBoundAnnotationChange(null);
                onSelectionChange(null);
            }
        };

        return (
            <div
               key={annotation.id}
               className="annotation-item absolute rounded"
               {...(annotation.text ? { 'data-tooltip': annotation.text, 'data-tooltip-delay': '600' } : {})}
               style={{
                   left: `${left}px`,
                   width: `${Math.max(2, width)}px`,
                   top: `${top}px`,
                   height: `${ANNOTATION_BOX_HEIGHT}px`,
                   border: `${isBound ? '2px' : '1px'} solid ${isBound ? 'white' : styleVars.borderColor}`,
                   backgroundColor: styleVars.bgColor,
                   boxShadow: isBound ? '0 0 0 2px rgba(255,255,255,0.4)' : '0 2px 4px rgba(0,0,0,0.5)',
                   zIndex: isSelected ? 20 : 10,
                   opacity: hideLabels ? 0.2 : 1,
                   transition: 'opacity 80ms ease-out',
               }}
               onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
               onMouseLeave={onAnnotationMouseLeave}
               onContextMenu={(e) => {
                   e.preventDefault();
                   e.stopPropagation();
                   onSelectAnnotation(annotation.id);
                   setContextMenu({ annotationId: annotation.id, x: e.clientX, y: e.clientY });
               }}
               onMouseDown={(e) => {
                   e.stopPropagation();
                   // Middle Click Delete
                   if (e.button === 1) {
                       e.preventDefault();
                       deleteAnnotation();
                       return;
                   }
                   // Right-click: leave selection/drag state alone so the
                   // container's mouseup doesn't also fire a bound selection —
                   // onContextMenu handles selecting and opening the menu.
                   if (e.button === 2) return;
                   onSelectAnnotation(annotation.id);
                   // Track for click vs drag detection
                   clickDownRef.current = { x: e.clientX, y: e.clientY, annotationId: annotation.id, pointerTime: getPointerTime(e) };
               }}
            >
               {/* Left resize handle */}
               <div
                   className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                   onMouseDown={(e) => {
                       e.stopPropagation();
                       if (e.button === 1) {
                           e.preventDefault();
                           deleteAnnotation();
                           return;
                       }
                       clickDownRef.current = null;
                       onSelectAnnotation(annotation.id);
                       setResizingAnnotation({ id: annotation.id, side: 'start', originalTime: annotation.start });
                       playheadFollowsAnnotationStartRef.current =
                         Math.abs(currentTimeStore.get() - annotation.start) <= 0.5;
                   }}
               >
                   {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
               </div>
               {/* Right resize handle */}
               <div
                   className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 z-10 flex items-center justify-center"
                   onMouseDown={(e) => {
                       e.stopPropagation();
                       if (e.button === 1) {
                           e.preventDefault();
                           deleteAnnotation();
                           return;
                       }
                       clickDownRef.current = null;
                       onSelectAnnotation(annotation.id);
                       setResizingAnnotation({ id: annotation.id, side: 'end', originalTime: annotation.end });
                   }}
               >
                   {width > 20 && <div className="w-[1px] h-3 bg-white/50" />}
               </div>

               {/* When editing (pencil or new empty annotation): show an input.
                   Otherwise: show a read-only span with ellipsis truncation.
                   The editor is NOT gated on width — zooming out until the box
                   is a sliver used to unmount it mid-word, dropping the caret
                   and the matching-tool dropdown. A box too narrow to hold the
                   text still gets a typeable editor (see editorStyle). */}
               {(editingInputId === annotation.id || (isSelected && annotation.text === '')) ? (
                       <AnnotationLabelInput
                           annotation={annotation}
                           annotations={annotations}
                           annotationTools={annotationTools}
                           isSelected={isSelected}
                           labelStyle={editorStyle}
                           inputRefs={inputRefs}
                           dropdownRef={elRef(annotation.id, 'dropdown')}
                           pendingAnnotationsRef={pendingAnnotationsRef}
                           onAnnotationsChange={onAnnotationsChange}
                           onAnnotationsCommit={onAnnotationsCommit}
                           onSelectAnnotation={onSelectAnnotation}
                           onDeselect={onDeselectAnnotation}
                           setEditingInputId={setEditingInputId}
                           deleteAnnotation={deleteAnnotation}
                           placeholder={copy.namePlaceholder}
                       />
                   ) : width > 30 ? (
                       <span
                           ref={elRef(annotation.id, 'label')}
                           className="absolute top-0 bottom-0 flex items-center text-xs font-bold pointer-events-none"
                           style={{
                               // Horizontal placement: left-aligned, clipped to annotation right edge.
                               ...labelStyle,
                               color: '#ffffff',
                               textShadow: '0 1px 2px black',
                               overflow: 'hidden',
                               whiteSpace: 'nowrap',
                               textOverflow: 'ellipsis',
                               display: 'block',
                               lineHeight: '30px',
                           }}
                       >
                           {annotation.text || <span className="opacity-30">{copy.namePlaceholder}</span>}
                       </span>
                   ) : null}

               {/* Pencil icon — appears on hover for Custom annotations only, click to focus text input */}
               {isHovered && isCustomAnnotation && (
                 width > 60 ? (
                   // Render inside the annotation
                   <button
                     ref={elRef(annotation.id, 'pencil')}
                     className="absolute top-0 bottom-0 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
                     style={{ right: `${pencilRight}px` }}
                     onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
                     onMouseLeave={onAnnotationMouseLeave}
                     onMouseDown={(e) => e.stopPropagation()}
                     onClick={(e) => {
                       e.stopPropagation();
                       focusAnnotationInput(annotation.id);
                     }}
                     data-tooltip={tooltips.editAnnotationName}
                   >
                     <Pencil size={10} className="text-white drop-shadow" />
                   </button>
                 ) : (
                   // Render outside to the right (floats above adjacent annotations)
                   <button
                     className="absolute flex items-center justify-center bg-slate-800/90 rounded p-0.5 hover:bg-slate-700 transition-colors"
                     style={{ left: `${Math.max(2, width) + 2}px`, top: '4px', zIndex: 50 }}
                     onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
                     onMouseLeave={onAnnotationMouseLeave}
                     onMouseDown={(e) => e.stopPropagation()}
                     onClick={(e) => {
                       e.stopPropagation();
                       focusAnnotationInput(annotation.id);
                     }}
                     data-tooltip={tooltips.editAnnotationName}
                   >
                     <Pencil size={10} className="text-white" />
                   </button>
                 )
               )}

               {/* Delete button */}
               <button
                   ref={elRef(annotation.id, 'delete')}
                   className={`absolute -top-3 ${isHovered ? 'flex' : 'hidden'} bg-red-500 rounded-full p-0.5 z-30`}
                   style={{ right: `${deleteRight}px` }}
                   onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
                   onMouseLeave={onAnnotationMouseLeave}
                   onClick={(e) => {
                       e.stopPropagation();
                       deleteAnnotation();
                   }}
               >
                   <X size={10} className="text-white" />
               </button>
            </div>
        );
      })}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
          minWidth={160}
        />
      )}
    </>
  );
};

// Memoised because the whole point of the transform above is that a scroll step
// costs no React work: Spectrogram still re-renders on one (`scrollLeft` state
// feeds the canvas dirty flags and the pointer handlers), and without this the
// overlay would re-render with it and hand back the cost we just removed.
export default React.memo(AnnotationOverlay);
