/**
 * Window-level drag scaffold: `onMove` for every mousemove until the button
 * comes up, then `onEnd`. Returns a cancel function (detaches without calling
 * `onEnd`) for a component unmounting mid-drag.
 */
export function startDragSession(onMove: (e: MouseEvent) => void, onEnd?: () => void): () => void {
  const move = (e: MouseEvent) => onMove(e);
  const detach = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  const up = () => {
    detach();
    onEnd?.();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  return detach;
}
