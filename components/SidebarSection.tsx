import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { sidebarSection as copy } from '../copy/ui';

interface SidebarSectionProps {
  /** Header content left of the actions — a plain label, or a richer strip. */
  title: React.ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Buttons rendered at the header's trailing edge. Hidden while collapsed. */
  actions?: React.ReactNode;
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
  /** Forwarded to the section root so the help guide can ghost it. */
  helpTarget?: string;
  children: React.ReactNode;
}

/**
 * One section of the left sidebar's vertical stack: a fixed header with a
 * collapse chevron, and a body that disappears when collapsed. Sizing is not
 * this component's business — the stack's flex layout (see
 * hooks/useSidebarSections.ts) gives an expanded section its share of the
 * height and shrinks a collapsed one to its header.
 *
 * Actions are hidden while collapsed: they act on content that isn't on screen,
 * and a collapsed header is a one-line strip with no room to spare.
 */
export default function SidebarSection({
  title, collapsed, onToggleCollapsed, actions, onHeaderContextMenu, helpTarget, children,
}: SidebarSectionProps) {
  return (
    <div className="flex flex-col min-h-0 h-full overflow-hidden" data-help-target={helpTarget}>
      <div
        className="flex items-center gap-1 pl-1 pr-2 py-1.5 bg-slate-800 border-b border-slate-700 flex-none"
        onContextMenu={onHeaderContextMenu}
      >
        <button
          onClick={onToggleCollapsed}
          className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors flex-none"
          data-tooltip={collapsed ? copy.expandSection : copy.collapseSection}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <div className="flex items-center gap-1 min-w-0 flex-1">{title}</div>
        {!collapsed && actions}
      </div>
      {!collapsed && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
      )}
    </div>
  );
}
