// The windows this app's React tree is currently drawn into: the main window,
// plus any panel popped out into its own window (components/PopoutPortal.tsx).
//
// A popped-out panel is a React portal, so its code still runs in the main
// window's JS context, but its DOM — and therefore its mouse and keyboard
// events — belongs to the popout's own `window`. A listener added with
// `window.addEventListener` only hears the main window. Global listeners
// (hotkeys, drag sessions, tooltips, click-outside) use `addWindowListener`
// instead, which attaches to every registered window, including ones that
// open later, and detaches from all of them at once.

type Options = boolean | AddEventListenerOptions;

interface Registration {
  type: string;
  handler: EventListener;
  options?: Options;
}

const windows = new Set<Window>();
if (typeof window !== 'undefined') windows.add(window);
const registrations = new Set<Registration>();

/** Listen on every open window. Returns the detach function. */
export function addWindowListener<K extends keyof WindowEventMap>(
  type: K,
  handler: (e: WindowEventMap[K]) => void,
  options?: Options,
): () => void {
  const reg: Registration = { type, handler: handler as EventListener, options };
  registrations.add(reg);
  windows.forEach(w => w.addEventListener(type, reg.handler, options));
  return () => {
    registrations.delete(reg);
    windows.forEach(w => w.removeEventListener(type, reg.handler, options));
  };
}

/** Add a window to the registry; every existing global listener starts hearing it. Returns the unregister function. */
export function registerWindow(w: Window): () => void {
  if (windows.has(w)) return () => {};
  windows.add(w);
  registrations.forEach(r => w.addEventListener(r.type, r.handler, r.options));
  return () => {
    windows.delete(w);
    // The window may already be gone; removing from a closed window is harmless.
    registrations.forEach(r => {
      try { w.removeEventListener(r.type, r.handler, r.options); } catch { /* closed */ }
    });
  };
}

/** Run `fn` against every open window (e.g. to set a body style while dragging). */
export function forEachWindow(fn: (w: Window) => void): void {
  windows.forEach(fn);
}

/** The window an event happened in. */
export function windowOf(e: Event): Window {
  const node = e.target as Node | null;
  return node?.ownerDocument?.defaultView ?? window;
}
