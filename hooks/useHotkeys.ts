import { useEffect, useRef } from 'react';
import { isMac } from '../utils/platform';

export type HotkeyMod = 'mod' | 'shift' | 'alt';

export interface HotkeyBinding {
  /** KeyboardEvent.key value (case-insensitive). Special: 'Digit' matches any 0-9. */
  key: string;
  /**
   * Required modifiers. Modifiers not listed here MUST NOT be pressed.
   * 'mod' = ⌘ on macOS, Ctrl on other platforms.
   */
  mods?: HotkeyMod[];
  /**
   * If true, fire even when focus is on an `<input>`, `<textarea>`, `<select>`,
   * or `[contenteditable]` element. Default false (matches the legacy
   * `tagName === 'INPUT'` early-return behaviour).
   *
   * Set true for keys that mean the same thing inside and outside text editing
   * (e.g. Escape, F1) — the local `onKeyDown` on the input can still handle the
   * key first and call `e.stopImmediatePropagation()` if it wants to suppress
   * the global handler.
   */
  allowInInput?: boolean;
  /** Call `preventDefault` when the binding fires. Default true. */
  preventDefault?: boolean;
  /**
   * Call `stopImmediatePropagation` when the binding fires, suppressing other
   * window-level keydown listeners (including other useHotkeys registrations).
   * Default false. Use for modal-style "this key belongs to me right now"
   * bindings (e.g. Esc closing an open help panel).
   */
  stop?: boolean;
  handler: (e: KeyboardEvent) => void;
}

function isInputLikeTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function modsMatch(e: KeyboardEvent, required: HotkeyMod[] | undefined): boolean {
  const wantMod = !!required?.includes('mod');
  const wantShift = !!required?.includes('shift');
  const wantAlt = !!required?.includes('alt');
  const hasMod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  // If the binding doesn't request 'mod', neither cmd nor ctrl may be down.
  if (!wantMod && otherMod) return false;
  return true;
}

function keyMatches(e: KeyboardEvent, key: string): boolean {
  if (key === 'Digit') return /^[0-9]$/.test(e.key);
  return e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Register a list of keyboard shortcuts on the window.
 *
 * Bindings are read from a ref that's refreshed on every render, so the array
 * (and the closures inside its handlers) can change freely without
 * re-attaching the listener. This avoids the dep-list churn that the previous
 * giant `useEffect` suffered from.
 *
 * Within one `useHotkeys` call: bindings are checked in array order; first
 * match wins.
 *
 * Across multiple `useHotkeys` calls: every matching binding fires unless one
 * sets `stop: true`.
 */
export function useHotkeys(bindings: HotkeyBinding[], enabled: boolean = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const inEditable = isInputLikeTarget(e.target);
      for (const b of ref.current) {
        if (!keyMatches(e, b.key)) continue;
        if (!modsMatch(e, b.mods)) continue;
        if (inEditable && !b.allowInInput) continue;
        if (b.preventDefault !== false) e.preventDefault();
        if (b.stop) e.stopImmediatePropagation();
        b.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}
