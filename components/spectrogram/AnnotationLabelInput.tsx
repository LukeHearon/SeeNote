import React from 'react';
import { Annotation, AnnotationTool } from '../../types';
import { updateAnnotation, ANNOTATION_BOX_HEIGHT } from '../../utils/helpers';
import { resolveLabelColor } from '../../utils/annotationTools';
import { useToolNameMatches } from '../../hooks/useToolNameMatches';
import ToolMatchDropdown from '../ToolMatchDropdown';

// The inline label editor for one annotation (pencil edit, or a just-created
// Custom annotation). Typing a partial label pops the same matching-tool
// dropdown as the Add-tool field: ArrowDown/ArrowUp highlight a row and Enter
// picks it; with nothing highlighted Enter commits the typed text as-is.
export default function AnnotationLabelInput({
  annotation, annotations, annotationTools, isSelected, labelStyle, inputRefs, dropdownRef,
  pendingAnnotationsRef, onAnnotationsChange, onAnnotationsCommit, onSelectAnnotation,
  onDeselect, setEditingInputId, deleteAnnotation, placeholder,
}: {
  annotation: Annotation;
  annotations: Annotation[];
  annotationTools: AnnotationTool[];
  isSelected: boolean;
  // left/right/width placement; a box too narrow to hold the label sends a
  // fixed-width style instead of one pinned to both edges (see AnnotationOverlay).
  labelStyle: { left: string; right: string; width?: string };
  inputRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  // Registers the match dropdown with AnnotationOverlay's pin registry: its
  // left edge tracks the label's, which the overlay re-pins per frame while
  // the view scrolls (see AnnotationOverlay's syncScroll).
  dropdownRef?: (el: HTMLDivElement | null) => void;
  pendingAnnotationsRef: React.MutableRefObject<Annotation[]>;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  // Full deselect (also drops the bound annotation + its selection region).
  // Falls back to onSelectAnnotation(null) when not supplied.
  onDeselect?: () => void;
  setEditingInputId: (id: string | null) => void;
  deleteAnnotation: () => void;
  placeholder: string;
}) {
  const { matches, activeIndex, setActiveIndex, itemRefs, handleArrowKeys } =
    useToolNameMatches(annotationTools, annotation.text, true);
  const open = matches.length > 0;

  // Typing a label that matches a defined tool adopts that tool's canonical
  // text + color; anything else is a Custom label.
  const applyText = (newText: string) => {
    const next = updateAnnotation(annotations, annotation.id, a => {
      const matchingTool = annotationTools.find(t => t.key !== '0' && t.text.toLowerCase() === newText.toLowerCase());
      const customColor = annotationTools.find(t => t.key === '0')?.color ?? '#ffffff';
      return {
        ...a,
        text: matchingTool ? matchingTool.text : newText,
        color: resolveLabelColor(newText, annotationTools, customColor),
      };
    });
    pendingAnnotationsRef.current = next;
    onAnnotationsChange(next);
    return next;
  };

  const pickMatch = (toolIndex: number) => {
    const next = applyText(annotationTools[toolIndex].text);
    onAnnotationsCommit(next);
    setEditingInputId(null);
    onSelectAnnotation(null);
    inputRefs.current[annotation.id]?.blur();
  };

  return (
    <>
      <input
        ref={(el) => { inputRefs.current[annotation.id] = el; }}
        type="text"
        value={annotation.text}
        onChange={(e) => applyText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (handleArrowKeys(e)) return;
          if (e.key === 'Enter') {
            if (open && matches[activeIndex]) {
              e.preventDefault();
              pickMatch(matches[activeIndex].toolIndex);
              return;
            }
            if (onDeselect) onDeselect(); else onSelectAnnotation(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            (e.target as HTMLInputElement).blur();
          }
        }}
        onFocus={() => {
          // Promote to explicit edit mode so the input stays mounted once the
          // user types. Without this, an auto-focused new annotation (rendered
          // only via `isSelected && text === ''`) unmounts the moment the first
          // character makes text non-empty, dropping focus.
          setEditingInputId(annotation.id);
        }}
        onBlur={() => {
          setEditingInputId(null);
          // An annotation left unnamed stays on screen — clicking away used to
          // delete it, so a stray click destroyed the box the user had just
          // drawn. It simply never reaches disk (isPersistableAnnotation), so
          // leaving the track is what discards it.
          onAnnotationsCommit(pendingAnnotationsRef.current);
        }}
        className="absolute top-0 bottom-0 bg-transparent text-xs placeholder-white/30 focus:outline-none"
        style={{
          ...labelStyle,
          textAlign: 'left',
          color: '#ffffff',
          fontWeight: 'bold',
          textShadow: '0 1px 2px black',
        }}
        placeholder={placeholder}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            deleteAnnotation();
            return;
          }
          e.stopPropagation();
        }}
        autoFocus={isSelected && annotation.text === ''}
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
      {open && (
        <div
          ref={dropdownRef}
          className="absolute z-50 flex flex-col gap-1 bg-slate-900 border border-slate-600 rounded shadow-lg p-1 min-w-[160px] max-w-[260px]"
          style={{ left: labelStyle.left, top: `${ANNOTATION_BOX_HEIGHT + 2}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ToolMatchDropdown
            matches={matches}
            activeIndex={activeIndex}
            setActiveIndex={setActiveIndex}
            itemRefs={itemRefs}
            onPick={pickMatch}
          />
        </div>
      )}
    </>
  );
}
