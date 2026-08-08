import React, { useCallback, useState } from 'react';
import { startDragSession } from './useCollapsibleSidebar';

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

export interface SidebarSectionsApi {
  states: SidebarSectionsState;
  setStates: React.Dispatch<React.SetStateAction<SidebarSectionsState>>;
  isCollapsed: (id: string) => boolean;
  toggleCollapsed: (id: string) => void;
  /** Flex style for a section: its weighted share, or nothing when collapsed. */
  styleFor: (id: string) => React.CSSProperties;
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

  const styleFor = useCallback((id: string): React.CSSProperties => {
    const s = stateOf(id);
    // Collapsed: the section is its header and nothing else, so let it size to
    // its content. Expanded: grow by weight from a zero basis, which makes the
    // weights a pure ratio regardless of what each body contains.
    return s.collapsed
      ? { flex: 'none' }
      : { flexGrow: s.weight, flexShrink: 1, flexBasis: 0, minHeight: 0 };
  }, [stateOf]);

  const handleDividerDrag = useCallback((ids: string[], dividerIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;

    // The sections a drag here actually resizes: the nearest expanded one above
    // the divider and the nearest below. Collapsed sections in between are
    // fixed-height headers, so they neither give nor take space.
    const findExpanded = (from: number, step: number): string | null => {
      for (let i = from; i >= 0 && i < ids.length; i += step) {
        if (!(states[ids[i]] ?? defaultState()).collapsed) return ids[i];
      }
      return null;
    };
    const aboveId = findExpanded(dividerIndex, -1);
    const belowId = findExpanded(dividerIndex + 1, 1);
    if (!aboveId || !belowId) return;

    // Current pixel heights, read once at mousedown. The two sections trade a
    // fixed pool of space between them, so the rest of the stack is untouched.
    const heightOf = (id: string) =>
      container.querySelector<HTMLElement>(`[data-sidebar-section="${id}"]`)?.getBoundingClientRect().height ?? 0;
    const startAbove = heightOf(aboveId);
    const startBelow = heightOf(belowId);
    const pool = startAbove + startBelow;
    if (pool <= 0) return;
    const startY = e.clientY;
    const startWeightSum = (states[aboveId] ?? defaultState()).weight + (states[belowId] ?? defaultState()).weight;

    startDragSession((moveEvent) => {
      const delta = moveEvent.clientY - startY;
      const nextAbove = startAbove + delta;
      const nextBelow = startBelow - delta;
      // Dragged past a section's minimum: collapse it rather than pinning the
      // drag at the minimum, so the divider stays under the cursor.
      if (nextAbove < MIN_SECTION_PX) {
        setStates(prev => ({ ...prev, [aboveId]: { ...(prev[aboveId] ?? defaultState()), collapsed: true } }));
        return;
      }
      if (nextBelow < MIN_SECTION_PX) {
        setStates(prev => ({ ...prev, [belowId]: { ...(prev[belowId] ?? defaultState()), collapsed: true } }));
        return;
      }
      // Weights are relative, so scale the new pixel split back onto the pair's
      // existing weight sum — that leaves every other section's share alone.
      setStates(prev => ({
        ...prev,
        [aboveId]: { ...(prev[aboveId] ?? defaultState()), collapsed: false, weight: (nextAbove / pool) * startWeightSum },
        [belowId]: { ...(prev[belowId] ?? defaultState()), collapsed: false, weight: (nextBelow / pool) * startWeightSum },
      }));
    });
  }, [states]);

  return { states, setStates, isCollapsed, toggleCollapsed, styleFor, handleDividerDrag };
}
