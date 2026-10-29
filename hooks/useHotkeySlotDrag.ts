import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';
import { applySlotDrop, resolveSlotDropTargetSticky, sameSlotDropTarget, SlotDropTarget } from '../utils/hotkeySlotDrag';

export type HotkeySlotDragState = { sourceIndex: number; target: SlotDropTarget | null } | null;

/**
 * How long (ms) a target must hold before its ghosts appear. The line, chevron
 * and outline track the pointer at once — they're local — but ghosts move many
 * rows, so they wait until the pointer settles rather than flashing on every
 * zone crossed mid-sweep.
 */
export const GHOST_DWELL_MS = 120;

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
    setDrag(d => (d && !sameSlotDropTarget(d.target, target) ? { ...d, target } : d));

  const onSlotsDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const spans = rows.current.map(el => el?.getBoundingClientRect());
    if (spans.some(s => !s)) return;
    setTarget(resolveSlotDropTargetSticky(tools, drag.sourceIndex, spans as DOMRect[], e.clientY, drag.target));
  };

  // Where the drop would put things, drawn as ghosts. `ghosts`: slot key → the
  // tool that would land there, for every slot whose occupant changes (the
  // dragged tool and everything it bumps or swaps). `unassignGhosts`: indices
  // of tools the drop would send to the Unassigned bin (dragged there, or
  // swapped out by a tool dragged in from it).
  // Computed from the dwell-settled target, not the live one (GHOST_DWELL_MS).
  const target = drag?.target ?? null;
  const [settled, setSettled] = useState<SlotDropTarget | null>(null);
  useEffect(() => {
    setSettled(null);
    if (!target) return;
    const id = setTimeout(() => setSettled(target), GHOST_DWELL_MS);
    return () => clearTimeout(id);
  }, [target]);

  const { ghosts, unassignGhosts } = useMemo(() => {
    const ghosts = new Map<string, AnnotationTool>();
    const unassignGhosts = new Set<number>();
    if (drag && settled && settled === drag.target) {
      const next = applySlotDrop(tools, drag.sourceIndex, settled);
      next.forEach((t, i) => {
        if (i === 0 || t.key === tools[i].key) return;
        if (t.key !== null) ghosts.set(t.key, t);
        else unassignGhosts.add(i);
      });
    }
    return { ghosts, unassignGhosts };
  }, [drag, settled, tools]);

  const commit = () => {
    if (drag?.target) {
      const newTools = applySlotDrop(tools, drag.sourceIndex, drag.target);
      // Dropping a tool back on its own slot changes nothing — don't record it.
      if (newTools.some((t, i) => t.key !== tools[i].key)) onCommit(newTools);
    }
    setDrag(null);
  };

  return { drag, ghosts, unassignGhosts, rowRef, begin, cancel, setTarget, onSlotsDragOver, commit };
}
