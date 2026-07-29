// Coalescing per-pixel-column canvas fills into runs.
//
// When frames are narrower than a pixel (a 10h recording in a ~1500px panel is
// ~25 frames per column), painting one rect per frame issues tens of thousands
// of fillRects per redraw — and redraw fires every frame of a pan or zoom — to
// produce a result that is, column for column, the same as painting each
// column once. This walks columns instead and merges adjacent columns with the
// same fill decision into a single rect, capping the work at O(panel width).

export interface ColumnRun {
  /** Left edge, in CSS pixels. */
  x: number;
  /** Width, in CSS pixels. */
  w: number;
}

/**
 * Merge the columns of [0, width) for which `fillAt(col)` is true into runs of
 * adjacent columns. `fillAt` is called exactly once per column, in order.
 */
export function coalesceColumnRuns(
  width: number,
  fillAt: (col: number) => boolean,
): ColumnRun[] {
  const runs: ColumnRun[] = [];
  const cols = Math.ceil(width);
  if (!(cols > 0)) return runs;
  let runStart = -1;
  for (let c = 0; c < cols; c++) {
    if (fillAt(c)) {
      if (runStart < 0) runStart = c;
    } else if (runStart >= 0) {
      runs.push({ x: runStart, w: c - runStart });
      runStart = -1;
    }
  }
  // The trailing run is clamped to the (possibly fractional) area width so it
  // can't paint past the edge of the drawing area.
  if (runStart >= 0) runs.push({ x: runStart, w: Math.min(cols, width) - runStart });
  return runs;
}
