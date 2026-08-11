import React, { useCallback, useState } from 'react';
import { startDragSession } from './useCollapsibleSidebar';
import { sectionFlexStyle } from '../utils/sidebarLayout';

/** Persisted per-section layout: relative share of the stack, and collapse state. */
export interface SidebarSectionState {
  /** Relative share of the space left over once collapsed sections take their headers. */
  weight: number;
  collapsed: boolean;
}

export type SidebarSectionsState = Record<string, SidebarSectionState>;

/**
 * An expanded section never shrinks below this. Dragging a divider that would
 * push a section under it collapses that section instead — the same
 * drag-past-the-minimum-to-collapse gesture the file panel's width already has
 * (see useCollapsibleSidebar), so the two dividers in the sidebar behave alike.
 */
const MIN_SECTION_PX = 72;

/**
 * How far a divider has to be dragged toward a collapsed neighbour before that
 * neighbour re-opens. Re-opening is only a *fallback* for when the drag has
 * nothing else to do (see the drag handler), so it needs a deliberate pull
 * rather than the pixel of travel a click sometimes carries.
 */
const EXPAND_SECTION_PX = 24;

export interface SidebarSectionsApi {
  states: SidebarSectionsState;
  setStates: React.Dispatch<React.SetStateAction<SidebarSectionsState>>;
  isCollapsed: (id: string) => boolean;
  toggleCollapsed: (id: string) => void;
  /** Flex style for a section: its weighted share, or nothing when collapsed. */
  styleFor: (id: string, ids: string[]) => React.CSSProperties;
  /**
   * mousedown handler for the divider drawn between two sections. `ids` is the
   * stack's full order (only the ids actually rendered), so the drag can find
   * the nearest expanded section on either side of the divider.
   */
  handleDividerDrag: (ids: string[], dividerIndex: number, e: React.MouseEvent) => void;
}

const defaultState = (): SidebarSectionState => ({ weight: 1, collapsed: false });

/**
 * Sizing and collapse state for the left sidebar's stack of sections (file
 * tree / annotation tools / neurons).
 *
 * Sections are laid out by flex-grow rather than by measured pixel heights, so
 * the browser redistributes space on window resize, on a section collapsing,
 * and on a section appearing or disappearing entirely (the neuron palette is
 * only present while buzzdetect data is loaded) — none of which this hook has
 * to model. Weights are only touched when the user drags a divider, and the
 * drag converts back to pixels at that moment for the arithmetic.
 */
export function useSidebarSections(initial: SidebarSectionsState): SidebarSectionsApi {
  const [states, setStates] = useState<SidebarSectionsState>(initial);

  const stateOf = useCallback(
    (id: string): SidebarSectionState => states[id] ?? defaultState(),
    [states],
  );

  const isCollapsed = useCallback((id: string) => stateOf(id).collapsed, [stateOf]);

  const toggleCollapsed = useCallback((id: string) => {
    setStates(prev => {
      const cur = prev[id] ?? defaultState();
      return { ...prev, [id]: { ...cur, collapsed: !cur.collapsed } };
    });
  }, []);

  const styleFor = useCallback(
    (id: string, ids: string[]): React.CSSProperties => sectionFlexStyle(states, ids, id),
    [states],
  );

  const handleDividerDrag = useCallback((ids: string[], dividerIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;

    const heightOf = (id: string) =>
      container.querySelector<HTMLElement>(`[data-sidebar-section="${id}"]`)?.getBoundingClientRect().height ?? 0;

    // Live section state for the drag. `states` is the snapshot from mousedown
    // and React's updates land after the handler has run, so the drag keeps its
    // own copy — otherwise a section it just collapsed (or re-opened), or a
    // weight it just wrote, would still read the old way on the next mousemove.
    const live: SidebarSectionsState = {};
    for (const id of ids) live[id] = { ...(states[id] ?? defaultState()) };

    // The sections a drag here actually resizes: the nearest expanded one above
    // the divider and the nearest below. Collapsed sections in between are
    // fixed-height headers, so they neither give nor take space.
    const findExpanded = (from: number, step: number): string | null => {
      for (let i = from; i >= 0 && i < ids.length; i += step) {
        if (!live[ids[i]].collapsed) return ids[i];
      }
      return null;
    };

    // The sections the divider sits directly between. These — not the nearest
    // expanded ones — are what a pull toward a collapsed side re-opens: the
    // handle you grab under a closed section is the handle that should open it.
    const upNeighbour = ids[dividerIndex];
    const downNeighbour = ids[dividerIndex + 1];

    // The pair being resized, and the pixel/weight baseline the drag measures
    // from. Re-derived whenever a section opens or closes mid-drag, because
    // both the pair and every height in the stack change at that moment.
    let aboveId: string | null = null;
    let belowId: string | null = null;
    let startAbove = 0;
    let startBelow = 0;
    let pool = 0;
    let startWeightSum = 0;
    let startY = e.clientY;
    // Set when a collapse/expand has been dispatched but the DOM hasn't caught
    // up yet: the next mousemove re-measures before doing anything else.
    let needsRebase = true;
    // Once a drag has closed something it stays a closing drag: without this,
    // carrying on in the same direction after a collapse would satisfy the
    // re-open rule below and pop a neighbour open at the end of the gesture.
    let collapsedThisDrag = false;

    const rebase = (clientY: number) => {
      needsRebase = false;
      aboveId = findExpanded(dividerIndex, -1);
      belowId = findExpanded(dividerIndex + 1, 1);
      startY = clientY;
      if (!aboveId || !belowId) { pool = 0; return; }
      startAbove = heightOf(aboveId);
      startBelow = heightOf(belowId);
      pool = startAbove + startBelow;
      startWeightSum = live[aboveId].weight + live[belowId].weight;
    };

    const setCollapsed = (id: string, collapsed: boolean) => {
      if (collapsed) collapsedThisDrag = true;
      live[id] = { ...live[id], collapsed };
      setStates(prev => ({ ...prev, [id]: { ...(prev[id] ?? defaultState()), collapsed } }));
      needsRebase = true;
    };

    startDragSession((moveEvent) => {
      if (needsRebase) { rebase(moveEvent.clientY); return; }
      const delta = moveEvent.clientY - startY;

      // Pulling toward a collapsed neighbour re-opens it, but only when the
      // drag has no other way to move the divider that way: with an expanded
      // section still available on the growing side, resizing (and, past the
      // minimum, collapsing) wins. That's what makes "throw the divider down"
      // reliably close things instead of re-opening whatever sits above it.
      const canExpandDown = !collapsedThisDrag && !belowId && live[downNeighbour].collapsed;
      const canExpandUp = !collapsedThisDrag && !aboveId && live[upNeighbour].collapsed;
      if (delta <= -EXPAND_SECTION_PX && canExpandDown) {
        setCollapsed(downNeighbour, false);
        return;
      }
      if (delta >= EXPAND_SECTION_PX && canExpandUp) {
        setCollapsed(upNeighbour, false);
        return;
      }
      if (!aboveId || !belowId || pool <= 0) return;

      const nextAbove = startAbove + delta;
      const nextBelow = startBelow - delta;
      // Dragged past a section's minimum: collapse it rather than pinning the
      // drag at the minimum, so the divider stays under the cursor.
      if (nextAbove < MIN_SECTION_PX) { setCollapsed(aboveId, true); return; }
      if (nextBelow < MIN_SECTION_PX) { setCollapsed(belowId, true); return; }
      // Weights are relative, so scale the new pixel split back onto the pair's
      // existing weight sum — that leaves every other section's share alone.
      const a = aboveId;
      const b = belowId;
      const wAbove = (nextAbove / pool) * startWeightSum;
      const wBelow = (nextBelow / pool) * startWeightSum;
      live[a] = { collapsed: false, weight: wAbove };
      live[b] = { collapsed: false, weight: wBelow };
      setStates(prev => ({
        ...prev,
        [a]: { ...(prev[a] ?? defaultState()), collapsed: false, weight: wAbove },
        [b]: { ...(prev[b] ?? defaultState()), collapsed: false, weight: wBelow },
      }));
    });
  }, [states]);

  return { states, setStates, isCollapsed, toggleCollapsed, styleFor, handleDividerDrag };
}
