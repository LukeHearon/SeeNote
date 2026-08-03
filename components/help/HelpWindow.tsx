import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DEFAULT_PAGE_ID, findPage } from './guide';
import { HelpContent } from './HelpContent';
import { HelpNav } from './HelpNav';
import TooltipLayer from '../TooltipLayer';
import { help } from '../../copy/help';
import { useHotkeys } from '../../hooks/useHotkeys';
import { onHelpMessage, postHelpMessage } from '../../utils/helpChannel';
import { useLiveClient } from '../../utils/liveBridge';
import { closeHelpWindow } from '../../utils/tauriCommands';

/**
 * The guide, as a standalone window (index.html?window=help). Two columns:
 * section tree and page body.
 *
 * The main window opens this via `open_help_window`; because a second call only
 * focuses the existing window, deep links after the first open arrive as
 * `navigate` messages on the help channel rather than as a fresh `?page=`.
 */
export function HelpWindow() {
  const [pageId, setPageId] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('page');
    return findPage(requested) ? requested! : DEFAULT_PAGE_ID;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  // Mirrors the main window's toolbar state so the guide's embedded controls
  // drive the open project — see utils/liveBridge.ts.
  const liveClient = useLiveClient();

  useEffect(() => onHelpMessage(msg => {
    if (msg.type === 'navigate' && findPage(msg.page)) setPageId(msg.page);
  }), []);

  // Closing the window mid-hover would otherwise leave the ghost highlight lit
  // in the main window with nothing left to clear it.
  useEffect(() => {
    const clear = () => postHelpMessage({ type: 'highlight', target: null });
    window.addEventListener('beforeunload', clear);
    return () => window.removeEventListener('beforeunload', clear);
  }, []);

  // Every page starts at the top; without this, switching from a long page to a
  // short one lands mid-document.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [pageId]);

  useHotkeys([
    { key: 'Escape', allowInInput: true, stop: true, handler: () => closeHelpWindow() },
  ]);

  const page = findPage(pageId) ?? findPage(DEFAULT_PAGE_ID)!;

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-900 text-slate-200">
      <header className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-slate-700 bg-slate-800">
        <span className="text-[#e65161] font-bold text-base">{help.windowTitle}</span>
        <button
          onClick={() => closeHelpWindow()}
          className="text-slate-400 hover:text-white transition-colors p-1 rounded hover:bg-slate-700"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="w-60 flex-none min-h-0">
          <HelpNav activePageId={page.id} onSelect={setPageId} />
        </div>
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
          <HelpContent page={page} client={liveClient} />
        </div>
      </div>

      {/* The embedded controls carry the same data-tooltip attributes as the
          real ones, so the guide needs the layer that renders them. */}
      <TooltipLayer />
    </div>
  );
}
