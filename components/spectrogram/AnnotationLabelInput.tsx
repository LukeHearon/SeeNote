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
  annotation, annotations, annotationTools, isSelected, labelStyle, inputRefs,
  pendingAnnotationsRef, onAnnotationsChange, onAnnotationsCommit, onSelectAnnotation,
  setEditingInputId, deleteAnnotation, placeholder,
}: {
  annotation: Annotation;
  annotations: Annotation[];
  annotationTools: AnnotationTool[];
  isSelected: boolean;
  labelStyle: { left: string; right: string };
  inputRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  pendingAnnotationsRef: React.MutableRefObject<Annotation[]>;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onAnnotationsCommit: (annotations: Annotation[]) => void;
  onSelectAnnotation: (id: string | null) => void;
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
            onSelectAnnotation(null);
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
          if (annotation.text.trim() === '') {
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
