import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { GUIDE, Part, pageSearchText, partOfPage } from './guide';
import { help } from '../../copy/help';

interface HelpNavProps {
  activePageId: string;
  onSelect: (pageId: string) => void;
}

/** Nested section tree: parts collapse, pages select. */
export function HelpNav({ activePageId, onSelect }: HelpNavProps) {
  const [query, setQuery] = useState('');
  // Parts start expanded; a part is collapsed only once the user closes it.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const q = query.trim().toLowerCase();
  const filtered: Part[] = useMemo(() => {
    if (!q) return GUIDE;
    return GUIDE
      .map(part => ({ ...part, pages: part.pages.filter(p => pageSearchText(p).includes(q)) }))
      .filter(part => part.pages.length > 0);
  }, [q]);

  const activePart = partOfPage(activePageId);
  // While filtering, every surviving part is shown open — collapsing a part you
  // just searched into would hide the only results.
  const isOpen = (partId: string) => !!q || !collapsed.has(partId);

  const toggle = (partId: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(partId)) next.delete(partId); else next.add(partId);
    return next;
  });

  return (
    <nav aria-label={help.navAriaLabel} className="flex flex-col h-full bg-slate-900/60 border-r border-slate-700">
      <div className="flex-none p-3 border-b border-slate-700/70">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={help.searchPlaceholder}
            className="w-full bg-slate-800 border border-slate-700 rounded pl-7 pr-2 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-[#e65161]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {filtered.length === 0 && (
          <p className="px-4 py-3 text-xs text-slate-500">{help.searchNoResults}</p>
        )}
        {filtered.map(part => {
          const open = isOpen(part.id);
          return (
            <div key={part.id} className="mb-1">
              <button
                onClick={() => toggle(part.id)}
                aria-expanded={open}
                className={`w-full flex items-center gap-1 px-3 py-1.5 text-[11px] uppercase tracking-wider font-medium transition-colors ${
                  activePart?.id === part.id ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                <span className="text-left">{part.title()}</span>
              </button>
              {open && (
                <ul className="ml-[1.35rem] border-l border-slate-700/70">
                  {part.pages.map(page => (
                    <li key={page.id}>
                      <button
                        onClick={() => onSelect(page.id)}
                        aria-current={page.id === activePageId ? 'page' : undefined}
                        className={`w-full text-left pl-3 pr-2 py-1.5 text-xs transition-colors border-l-2 -ml-px ${
                          page.id === activePageId
                            ? 'border-[#e65161] text-white bg-slate-800/70'
                            : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                        }`}
                      >
                        {page.title()}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
