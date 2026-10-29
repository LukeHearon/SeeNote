import type { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';

// Drag-to-reorder for the nine hotkey slots, shared by Annotation Tool Settings
// and the Labels palette. Three kinds of drop:
//   - onto an empty slot: the tool takes that key;
//   - onto an assigned tool: the two swap keys;
//   - between two assigned tools: the tool goes between them, bumping the
//     neighbours up or down into the nearest free slot on that side.
// The dragged tool's own slot counts as free — picking it up vacates it.

export type InsertDirection = 'up' | 'down';

export type SlotDropTarget =
  | { type: 'slot'; key: string }
  // `gap` g sits between HOTKEY_SLOTS[g] and HOTKEY_SLOTS[g + 1].
  | { type: 'insert'; gap: number; direction: InsertDirection }
  | { type: 'unassigned' };

/** Vertical extent of one slot row, in any shared coordinate space (e.g. client px). */
export interface RowSpan { top: number; bottom: number }

/**
 * Fraction of a row's height, at each edge, that reads as "between" rather than
 * "onto" when the neighbour across that edge is also assigned.
 */
export const INSERT_EDGE_FRACTION = 0.25;

// Slot-indexed occupant (tool index) of each hotkey slot, ignoring the dragged
// tool and the Custom tool. -1 = free.
function occupants(tools: AnnotationTool[], sourceIndex: number): number[] {
  return HOTKEY_SLOTS.map(k => tools.findIndex((t, i) => i !== 0 && i !== sourceIndex && t.key === k));
}

/** Whether a drop into gap `gap` can bump tools upward and/or downward. */
export function insertDirections(tools: AnnotationTool[], sourceIndex: number, gap: number): { up: boolean; down: boolean } {
  const occ = occupants(tools, sourceIndex);
  return {
    up: occ.slice(0, gap + 1).some(o => o === -1),
    down: occ.slice(gap + 1).some(o => o === -1),
  };
}

/**
 * Resolve the drop target under pointer `y`, given the nine slot rows' spans
 * (in HOTKEY_SLOTS order, top to bottom). A gap is only a target when both
 * tools around it are assigned and there's somewhere to bump into; otherwise
 * the pointer falls through to the nearest row (place or swap).
 */
export function resolveSlotDropTarget(
  tools: AnnotationTool[],
  sourceIndex: number,
  rows: RowSpan[],
  y: number,
): SlotDropTarget | null {
  if (rows.length !== HOTKEY_SLOTS.length) return null;
  const occ = occupants(tools, sourceIndex);

  // Nearest row, and — if the pointer is in an edge band or the space between
  // rows — the gap it's near.
  let row = 0;
  let gap: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const { top, bottom } = rows[i];
    const edge = (bottom - top) * INSERT_EDGE_FRACTION;
    if (y < top) {
      // Above row i: either above the whole list, or in the space after row i-1.
      if (i > 0) {
        gap = i - 1;
        row = y - rows[i - 1].bottom < top - y ? i - 1 : i;
      } else {
        row = 0;
      }
      break;
    }
    if (y <= bottom) {
      row = i;
      if (y < top + edge && i > 0) gap = i - 1;
      else if (y > bottom - edge && i < rows.length - 1) gap = i;
      break;
    }
    row = i; // below the last row
  }

  if (gap !== null && occ[gap] !== -1 && occ[gap + 1] !== -1) {
    const { up, down } = insertDirections(tools, sourceIndex, gap);
    if (up || down) {
      const mid = (rows[gap].bottom + rows[gap + 1].top) / 2;
      const direction: InsertDirection = up && down ? (y < mid ? 'up' : 'down') : up ? 'up' : 'down';
      return { type: 'insert', gap, direction };
    }
  }
  return { type: 'slot', key: HOTKEY_SLOTS[row] };
}

/** The tools after dropping `tools[sourceIndex]` on `target`. */
export function applySlotDrop(tools: AnnotationTool[], sourceIndex: number, target: SlotDropTarget | null): AnnotationTool[] {
  if (!target) return tools;

  if (target.type === 'unassigned') {
    return tools.map((t, i) => i === sourceIndex ? { ...t, key: null } : t);
  }

  if (target.type === 'slot') {
    const targetKey = target.key;
    const sourceKey = tools[sourceIndex].key;
    const occupantIndex = tools.findIndex((t, i) => i !== sourceIndex && t.key === targetKey);
    return tools.map((t, i) => {
      if (i === sourceIndex) return { ...t, key: targetKey };
      if (i === occupantIndex) return { ...t, key: sourceKey ?? null };
      return t;
    });
  }

  const { gap, direction } = target;
  const occ = occupants(tools, sourceIndex);
  const newKey = new Map<number, string>();
  if (direction === 'up') {
    let free = gap;
    while (free >= 0 && occ[free] !== -1) free--;
    if (free < 0) return tools;
    for (let j = free + 1; j <= gap; j++) newKey.set(occ[j], HOTKEY_SLOTS[j - 1]);
    newKey.set(sourceIndex, HOTKEY_SLOTS[gap]);
  } else {
    let free = gap + 1;
    while (free < occ.length && occ[free] !== -1) free++;
    if (free >= occ.length) return tools;
    for (let j = gap + 1; j < free; j++) newKey.set(occ[j], HOTKEY_SLOTS[j + 1]);
    newKey.set(sourceIndex, HOTKEY_SLOTS[gap + 1]);
  }
  return tools.map((t, i) => newKey.has(i) ? { ...t, key: newKey.get(i)! } : t);
}
