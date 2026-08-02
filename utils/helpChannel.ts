import { openHelpWindow } from './tauriCommands';

// Cross-window messaging for the help guide window.
//
// The guide lives in its own Tauri window (index.html?window=help), so it can't
// reach the main window's DOM directly. Both windows are same-origin, so a
// BroadcastChannel bridges them — the same mechanism copy/overrideStore.ts uses
// to keep copy overrides live across windows.
//
// Two directions of traffic:
//   help window → main window   'highlight'  hover a term, ghost the real control
//   main window → help window   'navigate'   open-on-page for an already-open window

export type HelpMessage =
  /** Ghost the element carrying `data-help-target={target}`; null clears. */
  | { type: 'highlight'; target: string | null }
  /** Ask an already-open help window to switch pages. */
  | { type: 'navigate'; page: string };

export const helpChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('seenote-help') : null;

export function postHelpMessage(msg: HelpMessage): void {
  helpChannel?.postMessage(msg);
}

/**
 * Open the guide on a given page, whether or not the window already exists.
 * `open_help_window` only focuses an existing window (its URL is fixed at
 * build time), so the page is also broadcast — a fresh window picks it up from
 * `?page=`, an already-open one from the `navigate` message.
 */
export function showHelpPage(page?: string): void {
  if (page) postHelpMessage({ type: 'navigate', page });
  openHelpWindow(page);
}

/**
 * Subscribe to help-channel messages. Returns an unsubscribe function, so it
 * drops straight into a useEffect cleanup.
 */
export function onHelpMessage(handler: (msg: HelpMessage) => void): () => void {
  if (!helpChannel) return () => {};
  const listener = (e: MessageEvent) => handler(e.data as HelpMessage);
  helpChannel.addEventListener('message', listener);
  return () => helpChannel.removeEventListener('message', listener);
}
