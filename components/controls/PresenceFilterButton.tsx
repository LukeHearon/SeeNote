import type { LucideIcon } from 'lucide-react';
import type { FileFilter } from '../../utils/fileFilter';

export interface PresenceFilterButtonProps {
  icon: LucideIcon;
  state: FileFilter;
  /** One tooltip per state: neutral, keeping tracks that have it, keeping tracks that lack it. */
  tooltips: { all: string; has: string; none: string };
  onClick: () => void;
}

/**
 * A three-state filter on one kind of per-track result. Gray is unfiltered,
 * blue keeps tracks that have the result, and red with a slash keeps tracks
 * that don't. The file panel uses one for annotations and one for buzzdetect
 * results.
 */
export function PresenceFilterButton({ icon: Icon, state, tooltips, onClick }: PresenceFilterButtonProps) {
  const color = state === 'annotated' ? 'text-sky-400' : state === 'unannotated' ? 'text-red-400' : 'text-slate-400 hover:text-white';
  const tooltip = state === 'annotated' ? tooltips.has : state === 'unannotated' ? tooltips.none : tooltips.all;
  return (
    <button
      onClick={onClick}
      className={`relative p-1 rounded hover:bg-slate-700 ${color}`}
      data-tooltip={tooltip}
    >
      {/* The slash is laid over a box exactly the icon's size: positioned
          against the button it drifts, since an inline icon leaves a baseline
          gap under itself and the button ends up taller than the icon. */}
      <span className="relative block w-[13px] h-[13px]">
        <Icon size={13} className="block" />
        {state === 'unannotated' && (
          <svg viewBox="0 0 24 24" className="absolute inset-0 w-full h-full pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        )}
      </span>
    </button>
  );
}
