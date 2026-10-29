import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';
import { applySlotDrop, resolveSlotDropTargetSticky, sameSlotDropTarget, SlotDropTarget } from '../utils/hotkeySlotDrag';

export type HotkeySlotDragState = { sourceIndex: number; target: SlotDropTarget | null } | null;

/**
 * How long (ms) a target must hold before any of its preview appears — ghosts,
 * the insert line and chevron, and the target outline alike — so sweeping the
 * pointer across the list doesn't flash a preview for every zone it crosses.
 * The drop itself always uses the live target.
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

  // Starting the drag hides the source chip (its slot reads as vacated). That
  // must wait a frame: React would otherwise apply it inside the dragstart
  // handler, while the browser is still snapshotting the drag image, and
  // WebKit abandons a drag whose source turns invisible there.
  const beginFrame = useRef<number | null>(null);
  const begin = (sourceIndex: number) => {
    if (beginFrame.current !== null) cancelAnimationFrame(beginFrame.current);
    beginFrame.current = requestAnimationFrame(() => {
      beginFrame.current = null;
      setDrag({ sourceIndex, target: null });
    });
  };
  const cancel = () => {
    if (beginFrame.current !== null) { cancelAnimationFrame(beginFrame.current); beginFrame.current = null; }
    setDrag(null);
  };

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
  // The preview follows the dwell-settled target, not the live one
  // (GHOST_DWELL_MS); null while the pointer hasn't settled.
  const target = drag?.target ?? null;
  const [settled, setSettled] = useState<SlotDropTarget | null>(null);
  useEffect(() => {
    setSettled(null);
    if (!target) return;
    const id = setTimeout(() => setSettled(target), GHOST_DWELL_MS);
    return () => clearTimeout(id);
  }, [target]);

  const preview = drag && settled && settled === drag.target ? settled : null;

  const { ghosts, unassignGhosts } = useMemo(() => {
    const ghosts = new Map<string, AnnotationTool>();
    const unassignGhosts = new Set<number>();
    if (drag && preview) {
      const next = applySlotDrop(tools, drag.sourceIndex, preview);
      next.forEach((t, i) => {
        // The dragged tool's own chip is hidden for the drag, so it's ghosted
        // even when the drop would leave it where it is.
        if (i === 0 || (t.key === tools[i].key && i !== drag.sourceIndex)) return;
        if (t.key !== null) ghosts.set(t.key, t);
        else unassignGhosts.add(i);
      });
    }
    return { ghosts, unassignGhosts };
  }, [drag, preview, tools]);

  const commit = () => {
    if (drag?.target) {
      const newTools = applySlotDrop(tools, drag.sourceIndex, drag.target);
      // Dropping a tool back on its own slot changes nothing — don't record it.
      if (newTools.some((t, i) => t.key !== tools[i].key)) onCommit(newTools);
    }
    setDrag(null);
  };

  return { drag, preview, ghosts, unassignGhosts, rowRef, begin, cancel, setTarget, onSlotsDragOver, commit };
}
