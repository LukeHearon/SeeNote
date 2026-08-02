import { RefObject, useEffect, useState } from 'react';
import { Page, tocEntries } from './guide';
import { help } from '../../copy/help';

interface HelpTocProps {
  page: Page;
  /** The content column's scroll container — the scroll-spy root. */
  scrollRef: RefObject<HTMLElement | null>;
}

/**
 * "On this page" rail. Entries are the page's `h` blocks; the active one is
 * whichever heading is highest in the viewport, falling back to the last
 * heading scrolled past once none are on screen.
 */
export function HelpToc({ page, scrollRef }: HelpTocProps) {
  const entries = tocEntries(page);
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);

  useEffect(() => {
    setActiveId(entries[0]?.id ?? null);
    const root = scrollRef.current;
    if (!root || entries.length === 0) return;

    const headings = Array.from(root.querySelectorAll<HTMLElement>('[data-toc-id]'));
    if (headings.length === 0) return;

    const pick = () => {
      const rootTop = root.getBoundingClientRect().top;
      // Highest heading whose top has reached the reading line (a little below
      // the top edge); before the first one is reached, keep the first entry.
      let current = headings[0];
      for (const h of headings) {
        if (h.getBoundingClientRect().top - rootTop <= 24) current = h;
        else break;
      }
      setActiveId(current.dataset.tocId ?? null);
    };

    pick();
    root.addEventListener('scroll', pick, { passive: true });
    return () => root.removeEventListener('scroll', pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, entries.length, scrollRef]);

  if (entries.length === 0) return <div className="w-52 flex-none" />;

  return (
    <aside className="w-52 flex-none border-l border-slate-700 overflow-y-auto py-6 px-4">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-2">{help.tocTitle}</p>
      <ul className="space-y-0.5">
        {entries.map(e => (
          <li key={e.id}>
            <button
              onClick={() => {
                const el = scrollRef.current?.querySelector<HTMLElement>(`[data-toc-id="${e.id}"]`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className={`w-full text-left text-xs py-1 border-l-2 pl-2 transition-colors ${
                e.id === activeId
                  ? 'border-[#e65161] text-white'
                  : 'border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {e.text}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
