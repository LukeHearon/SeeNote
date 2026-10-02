import React, { useCallback, useMemo, useState, RefObject } from 'react';
import { FolderOpen } from 'lucide-react';
import { useScrollSync } from '../hooks/useScrollSync';
import { fileTree as copy } from '../copy/ui';

// One row pinned to the top of the scroll view naming the folders the topmost
// visible row lives in, so you always know where you are in a deep tree. Only
// worth the row if enough tracks still fit below it.
const DEFAULT_ROW_H = 24;
const MIN_VISIBLE_TRACKS = 3;

/** Is the panel tall enough to give up a row to the breadcrumb? */
function fitsBreadcrumb(clientHeight: number, rowH: number): boolean {
  return rowH > 0 && clientHeight >= (MIN_VISIBLE_TRACKS + 1) * rowH;
}

/** Height of one tree row, measured off the first folder row. */
function measureRowHeight(scroller: HTMLElement): number {
  const firstFolder = scroller.querySelector('[data-folder-path]') as HTMLElement | null;
  return firstFolder?.offsetHeight || DEFAULT_ROW_H;
}

/**
 * How much of the top edge the breadcrumb would cover at `scrollTop`. It only
 * shows once scrolled, so a row scrolled to the top must land this far down to
 * stay visible.
 */
export function breadcrumbInset(scroller: HTMLElement, scrollTop: number): number {
  const rowH = measureRowHeight(scroller);
  return scrollTop > 0 && fitsBreadcrumb(scroller.clientHeight, rowH) ? rowH : 0;
}

/**
 * The pinned breadcrumb. Names the context of whichever row sits at the top
 * edge — one hit-test per frame, rather than a rect read per folder. Each row
 * reports its context itself (`data-crumb`), so the crumb deepens a level each
 * time a folder header scrolls under it. Owns its state so the panel doesn't
 * re-render per scroll tick.
 */
export default function PinnedBreadcrumb({
  containerRef,
  syncKey,
  root,
  onEnterFolder,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  syncKey: unknown;
  /** The folder the panel is showing; crumbs are named relative to it. */
  root: string | null;
  onEnterFolder: (path: string) => void;
}) {
  const [crumbPath, setCrumbPath] = useState<string | null>(null);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_H);

  const sync = useCallback((el: HTMLElement) => {
    const rowH = measureRowHeight(el);
    setRowHeight(prev => (prev === rowH ? prev : rowH));
    let path: string | null = null;
    const rect = el.getBoundingClientRect();
    if (el.scrollTop > 0 && fitsBreadcrumb(rect.height, rowH)) {
      // The whole stack at that point, so the breadcrumb's own clickable
      // folder names can't shadow the row beneath them.
      for (const node of document.elementsFromPoint(rect.left + 12, rect.top + 1)) {
        if (!el.contains(node)) continue;
        const hit = node.closest('[data-crumb]') as HTMLElement | null;
        if (hit) { path = hit.dataset.crumb ?? null; break; }
      }
    }
    setCrumbPath(prev => (prev === path ? prev : path));
  }, []);
  useScrollSync(containerRef, sync, syncKey);

  // Folders between the panel root and the row under the breadcrumb, each with
  // the path buildTree gave its node, so clicking one enters it.
  const crumbs = useMemo(() => {
    if (!crumbPath || !root || !crumbPath.startsWith(root)) return [];
    const names = crumbPath.substring(root.length + 1).split(/[\\/]/).filter(Boolean);
    return names.map((name, i) => ({ name, path: root + '/' + names.slice(0, i + 1).join('/') }));
  }, [crumbPath, root]);

  if (crumbs.length === 0) return null;
  return (
    // Only the folder names take the pointer; everything else passes through,
    // and the hit-test above reads past them.
    <div
      className="absolute left-0 right-2 top-0 z-30 flex items-center gap-1 px-2 bg-slate-900 border-b border-slate-700 pointer-events-none overflow-hidden"
      style={{ height: `${rowHeight}px`, boxShadow: '0 3px 5px -2px rgba(0,0,0,0.6)' }}
    >
      <FolderOpen size={13} className="flex-none text-slate-500" />
      {crumbs.map(({ name, path }, i) => (
        <React.Fragment key={path}>
          {i > 0 && <span className="text-[10px] text-slate-600 flex-none">/</span>}
          <button
            onClick={() => onEnterFolder(path)}
            // Parents shrink first so the folder you're actually in stays legible
            className={`text-xs truncate pointer-events-auto hover:text-white hover:underline ${i === crumbs.length - 1 ? 'text-slate-300 flex-none max-w-full' : 'text-slate-500 min-w-0'}`}
            data-tooltip={copy.enterFolder(name)}
            tabIndex={-1}
          >
            {name}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
