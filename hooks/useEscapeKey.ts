import { useEffect, useRef } from 'react';
import { isEditableTarget } from './useHotkeys';
import { addWindowListener } from '../utils/windowRegistry';

// Open dismissable layers, innermost last. Only the innermost one hears Escape,
// so closing a dialog opened from a modal doesn't close the modal too.
const stack: Array<{ current: () => void }> = [];
let removeListener: (() => void) | null = null;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return;
  // Escape in a text field belongs to the field (cancelling a draft); a second
  // press, with focus out of it, closes the layer.
  if (isEditableTarget(e.target)) return;
  e.preventDefault();
  // Captured at the window and stopped, so app-level shortcuts underneath (the
  // activation-stack Escape) don't also act on it.
  e.stopPropagation();
  stack[stack.length - 1].current();
}

/** Call `onEscape` when Escape is pressed and this is the innermost open layer. */
export function useEscapeKey(onEscape: (() => void) | undefined): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  const enabled = onEscape !== undefined;
  useEffect(() => {
    if (!enabled) return;
    const entry = { current: () => ref.current?.() };
    stack.push(entry);
    if (stack.length === 1) removeListener = addWindowListener('keydown', onKeyDown, true);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) { removeListener?.(); removeListener = null; }
    };
  }, [enabled]);
}
