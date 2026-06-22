import React from 'react';
import { annotationOverlay as copy } from '../../copy/ui';
import { tooltips } from '../../copy/tooltips';
import { X, Pencil } from 'lucide-react';
import { Annotation, AnnotationWithLayer, AnnotationTool, Selection, SpectrogramSettings } from '../../types';
import { updateAnnotation } from '../../utils/helpers';
import { timeToX, computeLabelPlacement } from '../../utils/viewportTransform';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';

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
}) => {
  return (
    <>
      {layeredAnnotations.map((annotation) => {
        const left = timeToX(annotation.start, scrollLeft, pixelsPerSecond);
        const width = (annotation.end - annotation.start) * pixelsPerSecond;
        const isSelected = selectedAnnotationId === annotation.id;
        const isBound = boundAnnotationId === annotation.id;

        if (left + width < 0 || left > containerWidth) return null;

        const top = 22 + (annotation.layerIndex * 35);

        const baseColor = annotation.color || "#ffffff";
        const isWhite = baseColor.toLowerCase() === "#ffffff" || baseColor.toLowerCase() === "#fff";

        const styleVars = isWhite ? {
            borderColor: isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.8)',
            bgColor: isSelected ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.15)',
            textColor: '#ffffff'
        } : {
            borderColor: baseColor,
            bgColor: isSelected ? `${baseColor}99` : `${baseColor}66`,
            textColor: baseColor
        };

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

        return (
            <div
               key={annotation.id}
               className="annotation-item absolute rounded"
               {...(annotation.text ? { 'data-tooltip': annotation.text, 'data-tooltip-delay': '600' } : {})}
               style={{
                   left: `${left}px`,
                   width: `${Math.max(2, width)}px`,
                   top: `${top}px`,
                   height: '30px',
                   border: `${isBound ? '2px' : '1px'} solid ${isBound ? 'white' : styleVars.borderColor}`,
                   backgroundColor: styleVars.bgColor,
                   boxShadow: isBound ? '0 0 0 2px rgba(255,255,255,0.4)' : '0 2px 4px rgba(0,0,0,0.5)',
                   zIndex: isSelected ? 20 : 10,
                   opacity: hideLabels ? 0.2 : 1,
                   transition: 'opacity 80ms ease-out',
               }}
               onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
               onMouseLeave={onAnnotationMouseLeave}
               onMouseDown={(e) => {
                   e.stopPropagation();
                   // Middle Click Delete
                   if (e.button === 1) {
                       e.preventDefault();
                       onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                       if (isSelected) onSelectAnnotation(null);
                       if (boundAnnotationId === annotation.id) {
                         onBoundAnnotationChange(null);
                         onSelectionChange(null);
                       }
                       return;
                   }
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
                       <input
                           ref={(el) => { inputRefs.current[annotation.id] = el; }}
                           type="text"
                           value={annotation.text}
                           onChange={(e) => {
                               const newText = e.target.value;
                               const newAnnotations = updateAnnotation(annotations, annotation.id, a => {
                                   const matchingTool = annotationTools.find(t => t.text.toLowerCase() === newText.toLowerCase() && t.key !== "0");
                                   if (matchingTool) {
                                        return { ...a, text: matchingTool.text, toolKey: matchingTool.key, color: matchingTool.color };
                                   }
                                   if (a.toolKey !== "0" && a.color !== "#ffffff" && a.text !== newText) {
                                       return { ...a, text: newText, toolKey: "0", color: "#ffffff" };
                                   }
                                   return { ...a, text: newText };
                               });
                               pendingAnnotationsRef.current = newAnnotations;
                               onAnnotationsChange(newAnnotations);
                           }}
                           onKeyDown={(e) => {
                               e.stopPropagation();
                               if (e.key === 'Enter') {
                                   onSelectAnnotation(null);
                                   (e.target as HTMLInputElement).blur();
                               }
                               if (e.key === 'Escape') {
                                   (e.target as HTMLInputElement).blur();
                               }
                           }}
                           onFocus={() => {
                               // Promote to explicit edit mode so the input stays mounted
                               // once the user types. Without this, an auto-focused new
                               // annotation (rendered only via `isSelected && text === ''`)
                               // unmounts the moment the first character makes text non-empty,
                               // dropping focus. Setting editingInputId keeps it rendered.
                               setEditingInputId(annotation.id);
                           }}
                           onBlur={() => {
                               setEditingInputId(null);
                               if (annotation.text.trim() === "") {
                                   const filtered = annotations.filter(a => a.id !== annotation.id);
                                   onAnnotationsCommit(filtered);
                                   onSelectAnnotation(null);
                               } else {
                                   onAnnotationsCommit(pendingAnnotationsRef.current);
                               }
                           }}
                           className="absolute top-0 bottom-0 bg-transparent text-xs placeholder-white/30 focus:outline-none"
                           style={{
                               ...labelStyle,
                               textAlign: 'left',
                               color: '#ffffff',
                               fontWeight: 'bold',
                               textShadow: '0 1px 2px black',
                           }}
                           placeholder={copy.namePlaceholder}
                           onMouseDown={(e) => {
                               if (e.button === 1) {
                                   e.preventDefault();
                                   e.stopPropagation();
                                   onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                                   if (isSelected) onSelectAnnotation(null);
                                   return;
                               }
                               e.stopPropagation();
                           }}
                           autoFocus={isSelected && annotation.text === ""}
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
                           {annotation.text || <span className="opacity-30">Name...</span>}
                       </span>
                   )
               ) : null}

               {/* Pencil icon — appears on hover, click to focus text input */}
               {isHovered && (
                 width > 60 ? (
                   // Render inside the annotation
                   <button
                     className="absolute top-0 bottom-0 right-5 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
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
                   className={`absolute -top-3 -right-3 ${isHovered ? 'flex' : 'hidden'} bg-red-500 rounded-full p-0.5 z-30`}
                   onMouseEnter={() => onAnnotationMouseEnter(annotation.id)}
                   onMouseLeave={onAnnotationMouseLeave}
                   onClick={(e) => {
                       e.stopPropagation();
                       onAnnotationsCommit(annotations.filter(a => a.id !== annotation.id));
                       if (isSelected) onSelectAnnotation(null);
                       if (boundAnnotationId === annotation.id) {
                         onBoundAnnotationChange(null);
                         onSelectionChange(null);
                       }
                   }}
               >
                   <X size={10} className="text-white" />
               </button>
            </div>
        );
      })}
    </>
  );
};

export default AnnotationOverlay;
