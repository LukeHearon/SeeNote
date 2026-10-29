import type { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';

// Drag-to-reorder for the nine hotkey slots, shared by Annotation Tool Settings
// and the Labels palette. Three kinds of drop:
//   - onto an empty slot: the tool takes that key;
//   - onto an assigned tool: the two swap keys;
//   - between two slots, next to an assigned tool: the tool goes between
//     them, bumping its neighbours up or down into the nearest free slot on
//     that side (above slot 1 / below slot 9 bumps everything down / up);
//     offered only where that bump would actually move another tool.
// The dragged tool's own slot counts as free — picking it up vacates it.

export type InsertDirection = 'up' | 'down';

export type SlotDropTarget =
  | { type: 'slot'; key: string }
  // `gap` g sits between HOTKEY_SLOTS[g] and HOTKEY_SLOTS[g + 1]; -1 is above
  // the first slot and HOTKEY_SLOTS.length - 1 below the last.
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
 * (in HOTKEY_SLOTS order, top to bottom). A gap — the space between rows, the
 * edge bands of an assigned row, or past either end of the list — is a target
 * when inserting there would bump at least one other tool; otherwise the
 * pointer falls through to the nearest row (place or swap). An empty row is a
 * place target edge to edge.
 */
export function resolveSlotDropTarget(
  tools: AnnotationTool[],
  sourceIndex: number,
  rows: RowSpan[],
  y: number,
): SlotDropTarget | null {
  if (rows.length !== HOTKEY_SLOTS.length) return null;
  // Rows with a tool on screen (the dragged tool still counts in its own slot;
  // only the bump itself treats that slot as free) have edge bands that read
  // as "between"; an empty row is all "onto".
  const shown = occupants(tools, -1);

  // Nearest row, and — if the pointer is in an edge band, the space between
  // rows, or past either end of the list — the gap it's near.
  let row = 0;
  let gap: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const { top, bottom } = rows[i];
    const edge = (bottom - top) * INSERT_EDGE_FRACTION;
    if (y < top) {
      // Above row i: either above the whole list, or in the space after row i-1.
      gap = i - 1;
      row = i > 0 && y - rows[i - 1].bottom < top - y ? i - 1 : i;
      break;
    }
    if (y <= bottom) {
      row = i;
      if (shown[i] !== -1) {
        if (y < top + edge) gap = i - 1;
        else if (y > bottom - edge) gap = i;
      }
      break;
    }
  }
  const last = rows.length - 1;
  if (y > rows[last].bottom) {
    // Below the last row.
    row = last;
    gap = last;
  }

  if (gap !== null) {
    // A direction is only offered if it bumps another tool. Without a bump the
    // insert is just a slot drop (into an empty neighbour, or back into the
    // dragged tool's own adjacent slot), which that slot's own zone covers.
    const space = insertDirections(tools, sourceIndex, gap);
    const bumps = (direction: InsertDirection) =>
      applySlotDrop(tools, sourceIndex, { type: 'insert', gap, direction })
        .some((t, i) => i !== sourceIndex && t.key !== tools[i].key);
    const up = space.up && bumps('up');
    const down = space.down && bumps('down');
    if (up || down) {
      const mid = gap < 0 ? -Infinity : gap >= rows.length - 1 ? Infinity
        : (rows[gap].bottom + rows[gap + 1].top) / 2;
      const direction: InsertDirection = up && down ? (y < mid ? 'up' : 'down') : up ? 'up' : 'down';
      return { type: 'insert', gap, direction };
    }
  }
  return { type: 'slot', key: HOTKEY_SLOTS[row] };
}

export const sameSlotDropTarget = (a: SlotDropTarget | null, b: SlotDropTarget | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * How far (px) the pointer must cross a zone boundary before the target
 * switches away from the current one. Stops the target — and with it the
 * preview — flip-flopping while the pointer rests on a boundary.
 */
export const TARGET_HYSTERESIS_PX = 4;

/**
 * resolveSlotDropTarget with hysteresis: stay on `prev` while it's still the
 * target anywhere within `hysteresisPx` of the pointer.
 */
export function resolveSlotDropTargetSticky(
  tools: AnnotationTool[],
  sourceIndex: number,
  rows: RowSpan[],
  y: number,
  prev: SlotDropTarget | null,
  hysteresisPx: number = TARGET_HYSTERESIS_PX,
): SlotDropTarget | null {
  const next = resolveSlotDropTarget(tools, sourceIndex, rows, y);
  if (!prev || prev.type === 'unassigned' || sameSlotDropTarget(next, prev)) return next;
  for (const dy of [-hysteresisPx, hysteresisPx]) {
    if (sameSlotDropTarget(resolveSlotDropTarget(tools, sourceIndex, rows, y + dy), prev)) return prev;
  }
  return next;
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
