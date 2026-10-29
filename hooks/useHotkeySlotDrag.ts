import React, { useCallback, useRef, useState } from 'react';
import type { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';
import { applySlotDrop, resolveSlotDropTarget, SlotDropTarget } from '../utils/hotkeySlotDrag';

export type HotkeySlotDragState = { sourceIndex: number; target: SlotDropTarget | null } | null;

const sameTarget = (a: SlotDropTarget | null, b: SlotDropTarget | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * HTML5 drag-and-drop over the nine hotkey slot rows, shared by Annotation
 * Tool Settings and the Labels palette. Register each row with `rowRef(i)`
 * (HOTKEY_SLOTS order) and put `onSlotsDragOver` on the element spanning the
 * rows and the gaps between them; the target (place / swap / insert-and-bump)
 * is resolved from the pointer against the rows' live rects.
 */
export function useHotkeySlotDrag(tools: AnnotationTool[], onCommit: (newTools: AnnotationTool[]) => void) {
  const [drag, setDrag] = useState<HotkeySlotDragState>(null);
  const rows = useRef<(HTMLElement | null)[]>(HOTKEY_SLOTS.map(() => null));

  const rowRef = useCallback((i: number) => (el: HTMLElement | null) => { rows.current[i] = el; }, []);

  const begin = (sourceIndex: number) => setDrag({ sourceIndex, target: null });
  const cancel = () => setDrag(null);

  const setTarget = (target: SlotDropTarget | null) =>
    setDrag(d => (d && !sameTarget(d.target, target) ? { ...d, target } : d));

  const onSlotsDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const spans = rows.current.map(el => el?.getBoundingClientRect());
    if (spans.some(s => !s)) return;
    setTarget(resolveSlotDropTarget(tools, drag.sourceIndex, spans as DOMRect[], e.clientY));
  };

  const commit = () => {
    if (drag?.target) {
      const newTools = applySlotDrop(tools, drag.sourceIndex, drag.target);
      // Dropping a tool back on its own slot changes nothing — don't record it.
      if (newTools.some((t, i) => t.key !== tools[i].key)) onCommit(newTools);
    }
    setDrag(null);
  };

  return { drag, rowRef, begin, cancel, setTarget, onSlotsDragOver, commit };
}
