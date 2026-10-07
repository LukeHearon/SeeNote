import { addWindowListener } from './windowRegistry';

/**
 * Window-level drag scaffold: `onMove` for every mousemove until the button
 * comes up, then `onEnd`. Returns a cancel function (detaches without calling
 * `onEnd`) for a component unmounting mid-drag.
 */
export function startDragSession(onMove: (e: MouseEvent) => void, onEnd?: () => void): () => void {
  const move = (e: MouseEvent) => onMove(e);
  const detach = () => {
    removeMove();
    removeUp();
  };
  const up = () => {
    detach();
    onEnd?.();
  };
  // Every open window, so a drag that starts in a popped-out panel still gets
  // its moves and its release.
  const removeMove = addWindowListener('mousemove', move);
  const removeUp = addWindowListener('mouseup', up);
  return detach;
}
