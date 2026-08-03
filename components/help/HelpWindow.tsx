import { useEffect, useRef, useState } from 'react';
import { PanelLeft, X } from 'lucide-react';
import { DEFAULT_PAGE_ID, findPage } from './guide';
import { HelpContent } from './HelpContent';
import { HelpNav } from './HelpNav';
import TooltipLayer from '../TooltipLayer';
import { help } from '../../copy/help';
import { useCollapsibleSidebar } from '../../hooks/useCollapsibleSidebar';
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
  const nav = useCollapsibleSidebar({ initialWidth: 240, minWidth: 150, maxWidth: 420, collapsedWidth: 40 });

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
        {/* Section rail — drag the right edge to resize, drag past the minimum
            to collapse it to a strip, exactly as the file panel behaves. */}
        {nav.collapsed ? (
          <div className="flex-none w-10 min-h-0 bg-slate-900/60 border-r border-slate-700 flex flex-col items-center pt-2 relative">
            <button
              onClick={() => nav.setCollapsed(false)}
              className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
              data-tooltip={help.showSections}
            >
              <PanelLeft size={16} />
            </button>
            <div
              className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
              style={{ right: '-3px', width: '6px' }}
              onMouseDown={nav.handleWidthDrag}
            />
          </div>
        ) : (
          <div className="flex-none min-h-0 relative" style={{ width: nav.width }}>
            <HelpNav activePageId={page.id} onSelect={setPageId} />
            <div
              className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
              style={{ right: '-3px', width: '6px' }}
              onMouseDown={nav.handleWidthDrag}
            />
          </div>
        )}
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
