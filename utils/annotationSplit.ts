import type { Annotation } from '../types';
import { generateId } from './helpers';

/**
 * Shortest piece a split may leave on either side, in seconds. A cut this close
 * to an edge is almost certainly a mis-aimed click, and a sliver that thin
 * can't be grabbed to resize or undo-by-hand.
 */
export const MIN_SPLIT_PIECE_SEC = 0.005;

/**
 * Split annotation `id` at time `t` (on whatever axis the list is in). The left
 * piece keeps the original id; the right piece gets a fresh one and sits right
 * after it in the list. Both drop `raw`, so the file rewrites them. Returns null
 * when the id isn't found or `t` doesn't fall strictly inside it.
 */
export function splitAnnotation(
  annotations: readonly Annotation[],
  id: string,
  t: number,
  newId: () => string = generateId,
): { annotations: Annotation[]; left: Annotation; right: Annotation } | null {
  const i = annotations.findIndex(a => a.id === id);
  if (i === -1) return null;
  const { raw: _raw, ...orig } = annotations[i];
  if (t - orig.start < MIN_SPLIT_PIECE_SEC || orig.end - t < MIN_SPLIT_PIECE_SEC) return null;
  const left: Annotation = { ...orig, end: t };
  const right: Annotation = { ...orig, id: newId(), start: t };
  const next = [...annotations.slice(0, i), left, right, ...annotations.slice(i + 1)];
  return { annotations: next, left, right };
}
