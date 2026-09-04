import React from 'react';

// The single white vertical marker for a selection edge — drawn by
// SelectionHandles for an active selection's start/end, and by
// AnnotationResizeLine for the one edge currently being dragged on an
// annotation that isn't also driving the selection region. Shared so a future
// style change (thickness, color) propagates to both without hunting down a
// second copy. `x` is a left offset in the caller's own coordinate space —
// content pixels for a full-viewport layer, or local pixels within a hit-area
// wrapper.
const BoundaryLine: React.FC<{ x: number }> = ({ x }) => (
  <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: `${x}px` }} />
);

export default BoundaryLine;
