import React, { useState } from 'react';
import { annotationOverlay as copy } from '../../copy/ui';
import { tooltips } from '../../copy/tooltips';
import { X, Pencil, Keyboard, Copy, Volume2 } from 'lucide-react';
import { Annotation, AnnotationWithLayer, AnnotationTool, Selection, SpectrogramSettings } from '../../types';
import { annotationColorStyle, annotationBoxTop, ANNOTATION_BOX_HEIGHT } from '../../utils/helpers';
import AnnotationLabelInput from './AnnotationLabelInput';
import { timeToX, computeLabelPlacement, computeButtonAnchorX } from '../../utils/viewportTransform';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { pickNextToolColor, nextAvailableHotkey } from '../../constants';
import ContextMenu, { ContextMenuItem } from '../ContextMenu';

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
  scrollLeft: number;
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
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onSelectionChange: (region: Selection | null) => void;
  onAnnotationMouseEnter: (id: string) => void;
  onAnnotationMouseLeave: () => void;
  setEditingInputId: (id: string | null) => void;
  setPencilClickedId: (id: string | null) => void;
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

// Per-annotation positioned divs: resize handles, the text input (edit mode) vs
// read-only span, pencil icon, delete button, colors and selection/bound visual
// states. Render-only — the center-drag/resize interaction state is owned by
// Spectrogram.tsx and reached via callbacks and shared refs.
const AnnotationOverlay: React.FC<AnnotationOverlayProps> = ({
  layeredAnnotations,
  annotations,
  selectedAnnotationId,
  boundAnnotationId,
  hoveredAnnotationId,
  editingInputId,
  annotationTools,
  selection,
  scrollLeft,
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
  onAnnotationsChange,
  onAnnotationsCommit,
  onBoundAnnotationChange,
  onSelectionChange,
  onAnnotationMouseEnter,
  onAnnotationMouseLeave,
  setEditingInputId,
  setPencilClickedId,
  setResizingAnnotation,
  onCreateTool,
  onBindHotkey,
  onListenExample,
}) => {
  const [contextMenu, setContextMenu] = useState<AnnotationContextMenuState | null>(null);

  const contextMenuItems = (state: AnnotationContextMenuState): ContextMenuItem[] => {
    const ann = annotations.find(a => a.id === state.annotationId);
    if (!ann) return [];
    const existingTool = annotationTools.find(t => t.key !== '0' && t.text.toLowerCase() === ann.text.toLowerCase());
    const nextKey = nextAvailableHotkey(annotationTools);
    const alreadyBound = existingTool != null && existingTool.key !== null;
    return [
      {
        label: copy.contextBindHotkey,
        icon: <Keyboard size={12} />,
        disabled: !ann.text || alreadyBound || nextKey === null,
        onSelect: () => {
          if (!nextKey) return;
          if (existingTool) {
            onBindHotkey(existingTool.id, nextKey);
          } else {
            onCreateTool(ann.text, pickNextToolColor(annotationTools), nextKey);
          }
        },
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

  return (
    <>
      {layeredAnnotations.map((annotation) => {
        const left = timeToX(annotation.start, scrollLeft, pixelsPerSecond);
        const width = (annotation.end - annotation.start) * pixelsPerSecond;
        const isSelected = selectedAnnotationId === annotation.id;
        const isBound = boundAnnotationId === annotation.id;

        if (left + width < 0 || left > containerWidth) return null;

        const top = annotationBoxTop(annotation.layerIndex);

        const baseColor = annotation.color || "#ffffff";
        const isCustomAnnotation = baseColor.toLowerCase() === "#ffffff" || baseColor.toLowerCase() === "#fff";
        const styleVars = annotationColorStyle(baseColor, isSelected);

        const isHovered = hoveredAnnotationId === annotation.id;

        // Horizontal placement of the name label. Handles screen-left pinning
        // (annotation start scrolled off the left) and the selection "pop":
        // an overlapping selection pushes the label right. The label is always
        // left-aligned; long text is truncated with an ellipsis. LABEL_INSET
        // matches the 8px inset used below.
        const LABEL_INSET = 8;
        const labelPlacement = computeLabelPlacement({
            annStartX: left,
            annEndX: left + width,
            selStartX: selection ? timeToX(selection.start, scrollLeft, pixelsPerSecond) : null,
            selEndX: selection ? timeToX(selection.end, scrollLeft, pixelsPerSecond) : null,
            inset: LABEL_INSET,
            textWidth: 0,
        });
        // Convert container-px placement to a style relative to the
        // annotation div (whose origin is at container x = left).
        const labelStyle = { left: `${labelPlacement.leftX - left}px`, right: `${LABEL_INSET}px` };

        // Screen-right pinning for the edit/delete hover buttons, mirroring the
        // label's screen-left pin: when the annotation's end scrolls off the
        // right of the viewport, the buttons pin near the viewport's right edge
        // instead of sitting off-screen past the annotation's actual end.
        const PENCIL_INSET = 20; // matches the removed `right-5` (1.25rem)
        const pencilRight = (left + width) - computeButtonAnchorX(left, left + width, containerWidth, PENCIL_INSET, PENCIL_INSET, 24);
        // The delete badge overhangs the annotation's own edge (-right-3), but
        // when pinned it must stay fully inside the viewport, so the pinned
        // inset is a positive margin rather than reusing the overhang value.
        const DELETE_NATURAL_INSET = -12; // matches the removed `-right-3` (-0.75rem)
        const DELETE_PINNED_INSET = 12;
        const deleteRight = (left + width) - computeButtonAnchorX(left, left + width, containerWidth, DELETE_NATURAL_INSET, DELETE_PINNED_INSET, 16);

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

               {width > 30 ? (
                   // When editing (pencil or new empty annotation): show an input.
                   // Otherwise: show a read-only span with ellipsis truncation.
                   (editingInputId === annotation.id || (isSelected && annotation.text === '')) ? (
                       <AnnotationLabelInput
                           annotation={annotation}
                           annotations={annotations}
                           annotationTools={annotationTools}
                           isSelected={isSelected}
                           labelStyle={labelStyle}
                           inputRefs={inputRefs}
                           pendingAnnotationsRef={pendingAnnotationsRef}
                           onAnnotationsChange={onAnnotationsChange}
                           onAnnotationsCommit={onAnnotationsCommit}
                           onSelectAnnotation={onSelectAnnotation}
                           setEditingInputId={setEditingInputId}
                           deleteAnnotation={deleteAnnotation}
                           placeholder={copy.namePlaceholder}
                       />
                   ) : (
                       <span
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
                   )
               ) : null}

               {/* Pencil icon — appears on hover for Custom annotations only, click to focus text input */}
               {isHovered && isCustomAnnotation && (
                 width > 60 ? (
                   // Render inside the annotation
                   <button
                     className="absolute top-0 bottom-0 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
                     style={{ right: `${pencilRight}px` }}
                     onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
                     onMouseLeave={onAnnotationMouseLeave}
                     onMouseDown={(e) => e.stopPropagation()}
                     onClick={(e) => {
                       e.stopPropagation();
                       setEditingInputId(annotation.id);
                       setPencilClickedId(annotation.id);
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
                       setEditingInputId(annotation.id);
                       setPencilClickedId(annotation.id);
                     }}
                     data-tooltip={tooltips.editAnnotationName}
                   >
                     <Pencil size={10} className="text-white" />
                   </button>
                 )
               )}

               {/* Delete button */}
               <button
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

export default AnnotationOverlay;
