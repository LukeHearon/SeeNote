import React from 'react';
import type { SidebarSectionsApi } from '../hooks/useSidebarSections';

export interface SidebarStackItem {
  id: string;
  node: React.ReactNode;
}

/**
 * The left sidebar's vertical stack of sections, with a drag handle between
 * each neighbouring pair. Only the sections passed in are rendered — the
 * neuron palette drops out entirely when no buzzdetect data is loaded, and the
 * stack reflows without any special-casing because sizing is by flex weight
 * (see hooks/useSidebarSections.ts).
 *
 * Each section is tagged `data-sidebar-section` so a divider drag can measure
 * its neighbours' current pixel heights.
 */
export default function SidebarStack({
  items, sections,
}: { items: SidebarStackItem[]; sections: SidebarSectionsApi }) {
  const ids = items.map(i => i.id);
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {items.map((item, i) => (
        <React.Fragment key={item.id}>
          {i > 0 && (
            <div
              className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors flex-none z-10 flex justify-center items-center"
              onMouseDown={(e) => sections.handleDividerDrag(ids, i - 1, e)}
            >
              <div className="w-12 h-1 bg-slate-600 rounded-full" />
            </div>
          )}
          <div
            data-sidebar-section={item.id}
            style={sections.styleFor(item.id)}
            className="overflow-hidden flex flex-col"
          >
            {item.node}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
