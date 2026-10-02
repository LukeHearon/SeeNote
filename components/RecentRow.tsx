import React from 'react';
import { Star, X } from 'lucide-react';
import { launchScreen } from '../copy/ui';
import { tooltips } from '../copy/tooltips';

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
};

/**
 * One entry in the launch screen's recent list — a project or a single file:
 * title and kind badge, detail lines, star, remove, and any extra actions,
 * with the last-opened date underneath.
 */
export default function RecentRow({
  title, badge, badgeClassName, details, lastOpened, grayed = false, starred,
  onOpen, onContextMenu, onToggleStar, onRemove, removeTooltip, actions, hoverActions,
}: {
  title: React.ReactNode;
  badge: string;
  badgeClassName: string;
  details: React.ReactNode;
  lastOpened: string;
  /** Tried and failed to resolve: dimmed. */
  grayed?: boolean;
  starred: boolean;
  onOpen: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
  removeTooltip: string;
  /** Always visible, before the star (e.g. Re-link). */
  actions?: React.ReactNode;
  /** Shown on hover, between star and remove (e.g. settings). */
  hoverActions?: React.ReactNode;
}) {
  return (
    <li
      onClick={onOpen}
      onAuxClick={e => { if (e.button === 1) onRemove(e); }}
      onContextMenu={onContextMenu}
      className={`group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all${grayed ? ' text-gray-500 opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="font-bold truncate">{title}</p>
            <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded text-gray-400 border border-gray-700 ${badgeClassName}`}>
              {badge}
            </span>
          </div>
          {details}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {starred && (
            <button
              onClick={onToggleStar}
              className="text-yellow-400 hover:text-yellow-300 p-1 rounded transition-colors"
              data-tooltip={tooltips.unstarProject}
            >
              <Star size={15} fill="currentColor" />
            </button>
          )}
          <div className="hidden group-hover:flex items-center gap-2">
            {!starred && (
              <button
                onClick={onToggleStar}
                className="text-gray-400 hover:text-yellow-400 p-1 rounded transition-colors"
                data-tooltip={tooltips.starProject}
              >
                <Star size={15} />
              </button>
            )}
            {hoverActions}
            <button
              onClick={onRemove}
              className="text-gray-400 hover:text-red-400 p-1 rounded transition-colors"
              data-tooltip={removeTooltip}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </div>
      <p className="text-gray-600 text-xs mt-2">{launchScreen.lastOpened(formatDate(lastOpened))}</p>
    </li>
  );
}
