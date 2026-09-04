import React from 'react';
import { Annotation } from '../../types';
import type { ScrollSyncHub } from '../../utils/scrollSyncHub';
import { useScrollTransformLayer } from '../../hooks/useScrollTransformLayer';
import BoundaryLine from './BoundaryLine';

interface AnnotationResizeLineProps {
  resizingAnnotation: { id: string; side: 'start' | 'end'; originalTime: number } | null;
  annotations: Annotation[];
  // The annotation currently mirrored into the selection region (if any) —
  // that case already gets the full active-selection treatment (dimming,
  // dotted spine, SelectionHandles' own lines), so this component stays out
  // of its way rather than drawing a redundant second line on top of it.
  boundAnnotationId: string | null;
  scrollLeftRef: React.MutableRefObject<number>;
  scrollSync: ScrollSyncHub;
  pixelsPerSecond: number;
}

// A single white line marking the edge of an annotation being dragged by its
// resize handle, when that annotation isn't the one bound to the selection
// region. Same marker as an active selection's edges (BoundaryLine), just the
// one line for the one handle in play — no dimming, no dotted spine.
const AnnotationResizeLine: React.FC<AnnotationResizeLineProps> = ({
  resizingAnnotation,
  annotations,
  boundAnnotationId,
  scrollLeftRef,
  scrollSync,
  pixelsPerSecond,
}) => {
  const layer = useScrollTransformLayer(scrollSync, scrollLeftRef);

  const showing = resizingAnnotation && resizingAnnotation.id !== boundAnnotationId;
  const annotation = showing ? annotations.find(a => a.id === resizingAnnotation!.id) : undefined;
  if (!annotation) return null;

  const time = resizingAnnotation!.side === 'start' ? annotation.start : annotation.end;
  const x = time * pixelsPerSecond;

  return (
    <div ref={layer.ref} className="absolute top-0 left-0 w-full h-full pointer-events-none" style={{ ...layer.style, zIndex: 15 }}>
      <BoundaryLine x={x} />
    </div>
  );
};

export default React.memo(AnnotationResizeLine);
