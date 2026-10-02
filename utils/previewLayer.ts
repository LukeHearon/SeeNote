import type { AnnotationWithLayer } from '../types';

/**
 * The vertical layer an annotation spanning [start, end] would get if it were
 * added to `layered` (the output of calculateAnnotationLayers, which is sorted
 * by start with the greedy earliest-free-layer assignment).
 *
 * Equivalent to appending it to the list and re-running calculateAnnotationLayers,
 * then reading its layerIndex — but without the copy and re-sort, which the
 * overlay was paying every frame for a preview. The new annotation sorts after
 * every existing one that starts at or before it (stable sort, appended last),
 * and the greedy pass only looks backwards, so its layer depends solely on those:
 * replay each one's layer end, then take the first layer free at `start`.
 */
export const previewLayerIndex = (
  layered: readonly AnnotationWithLayer[],
  start: number,
): number => {
  const layerEnds: number[] = [];
  for (const a of layered) {
    if (a.start > start) break;
    layerEnds[a.layerIndex] = a.end;
  }
  for (let i = 0; i < layerEnds.length; i++) {
    if (layerEnds[i] <= start) return i;
  }
  return layerEnds.length;
};
