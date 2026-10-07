import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine } from 'lucide-react';
import TooltipLayer from './TooltipLayer';
import { registerWindow } from '../utils/windowRegistry';
import { tooltips } from '../copy/tooltips';

interface Props {
  title: string;
  /** Called when the window goes away on its own (the user closed it). */
  onClosed: () => void;
  /** Controls shown in the popout's header, left of the pop-in button. */
  headerActions?: ReactNode;
  children: ReactNode;
}

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 420;
const CLOSED_POLL_MS = 500;

interface Popout {
  win: Window;
  container: HTMLElement;
}

// Native-window creation (src-tauri/src/commands/window.rs build_main_window)
// answers `window.open`. The new window is same-origin with this one, so React
// can render straight into its document: the panel keeps running against this
// window's state, engine and caches, which is what lets a popped-out
// spectrogram still seek, select and annotate.
function openPopout(title: string): Popout | null {
  const left = Math.round(window.screenX + 48);
  const top = Math.round(window.screenY + 72);
  const win = window.open(
    'about:blank',
    '_blank',
    `popup=yes,width=${DEFAULT_WIDTH},height=${DEFAULT_HEIGHT},left=${left},top=${top}`,
  );
  if (!win) return null;

  const doc = win.document;
  doc.title = `SeeNote – ${title}`;
  doc.documentElement.className = document.documentElement.className;
  doc.body.className = document.body.className;
  doc.body.style.margin = '0';
  // The stylesheets, by absolute URL (an about:blank document has nothing for a
  // relative one to resolve against) — Vite's <link> in a build, <style> tags in dev.
  document.head.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
    const copy = doc.importNode(node, true) as HTMLElement;
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    doc.head.appendChild(copy);
  });

  const container = doc.createElement('div');
  container.className = 'flex flex-col bg-slate-900 text-slate-200 overflow-hidden';
  container.style.width = '100vw';
  container.style.height = '100vh';
  doc.body.appendChild(container);
  return { win, container };
}

/**
 * Renders its children into a window of its own for as long as it's mounted,
 * under a header with the pop-in button. Unmounting closes the window.
 */
export default function PopoutPortal({ title, onClosed, headerActions, children }: Props) {
  const [popout, setPopout] = useState<Popout | null>(null);
  // A ref, so the effect doesn't reopen the window when the parent passes a
  // fresh callback.
  const onClosedStable = useRef(onClosed);
  onClosedStable.current = onClosed;

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    // Opened a tick late: StrictMode mounts, unmounts and remounts effects
    // back to back in dev, and a window closed before it has finished opening
    // is left behind as a blank second one. The throwaway mount's cleanup
    // cancels this before anything opens.
    const timer = window.setTimeout(() => {
      const opened = openPopout(title);
      if (!opened) {
        onClosedStable.current();
        return;
      }
      const { win } = opened;
      let tearingDown = false;
      const unregister = registerWindow(win);
      const handleGone = () => {
        if (tearingDown) return;
        tearingDown = true;
        onClosedStable.current();
      };
      // Closing the window from its title bar doesn't always raise pagehide in
      // the webview, so also poll for it.
      win.addEventListener('pagehide', handleGone);
      const poll = window.setInterval(() => { if (win.closed) handleGone(); }, CLOSED_POLL_MS);
      // The popout can't outlive the window that owns its state.
      const closeWithMain = () => { tearingDown = true; win.close(); };
      window.addEventListener('pagehide', closeWithMain);
      setPopout(opened);
      cleanup = () => {
        tearingDown = true;
        window.clearInterval(poll);
        window.removeEventListener('pagehide', closeWithMain);
        unregister();
        setPopout(null);
        win.close();
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
    // The window is opened once per mount; the title only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!popout) return null;
  return createPortal(
    <>
      <div className="flex-none h-7 flex items-center gap-2 px-2 bg-slate-800 border-b border-slate-700">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 flex-1 truncate">{title}</span>
        {headerActions}
        <button
          type="button"
          onClick={() => onClosedStable.current()}
          className="p-1 rounded text-slate-400 hover:bg-slate-700 hover:text-white transition-colors"
          data-tooltip={tooltips.popInPanel}
        >
          <ArrowDownToLine size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col relative">{children}</div>
      <TooltipLayer ownerWindow={popout.win} />
    </>,
    popout.container,
  );
}
