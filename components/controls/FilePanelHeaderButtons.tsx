import type React from 'react';
import { Activity, FoldVertical, StickyNote, UnfoldVertical } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';
import type { FileFilter } from '../../utils/fileFilter';
import type { ColumnLayout } from '../../utils/fileTreeColumns';
import { PresenceFilterButton } from './PresenceFilterButton';

export type { FileFilter };

export interface FilePanelHeaderButtonsProps {
  /** Hides the expand/collapse button — shuffle mode has no folder tree. */
  shuffleMode: boolean;
  /** Whether any folder is open, which is what the expand/collapse button flips. */
  anyExpanded: boolean;
  fileFilter: FileFilter;
  /** The buzzdetect filter (and its column) only exist when the project names a buzzdetect directory. */
  showBuzzdetect: boolean;
  buzzdetectFilter: FileFilter;
  onToggleExpandCollapse: () => void;
  onToggleFileFilter: () => void;
  onToggleBuzzdetectFilter: () => void;
  /**
   * The list's result columns, when it has them. Each filter button then sits
   * in a slot the width of its column, so it lines up above the counts it
   * filters. Absent in the guide's live copy, which has no list beneath it.
   */
  columns?: ColumnLayout;
}

/**
 * The button cluster on the right of the file panel's header. Extracted from
 * FileTree so the help guide can render a working copy (components/help/
 * LiveControls.tsx) instead of describing the icons in prose.
 */
export function FilePanelHeaderButtons({
  shuffleMode,
  anyExpanded,
  fileFilter,
  showBuzzdetect,
  buzzdetectFilter,
  onToggleExpandCollapse,
  onToggleFileFilter,
  onToggleBuzzdetectFilter,
  columns,
}: FilePanelHeaderButtonsProps) {
  const aligned = columns?.annotation ?? false;
  // A slot over one result column; the divider continues the one down the list.
  const slot = (show: boolean | undefined, child: React.ReactNode) => (show && columns
    ? <div className="flex-none flex items-center justify-center border-l border-slate-700/60" style={{ width: `${columns.widthPx}px` }}>{child}</div>
    : child);
  const expandButton = shuffleMode ? null : (
    <button
      onClick={onToggleExpandCollapse}
      className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
      data-tooltip={anyExpanded ? tooltips.collapseAll : tooltips.expandAll}
    >
      {anyExpanded ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
    </button>
  );
  const expandInTotalSlot = columns?.total ?? false;
  return (
    <div className={`flex items-center flex-none ${aligned ? '' : 'gap-0.5'}`} data-help-target="file-panel-header">
      {!expandInTotalSlot && expandButton}
      {slot(columns?.annotation, (
        <PresenceFilterButton
          icon={StickyNote}
          state={fileFilter}
          tooltips={{ all: tooltips.annotationFilterAll, has: tooltips.annotationFilterHas, none: tooltips.annotationFilterNone }}
          onClick={onToggleFileFilter}
        />
      ))}
      {showBuzzdetect && slot(columns?.buzzdetect, (
        <PresenceFilterButton
          icon={Activity}
          state={buzzdetectFilter}
          tooltips={{ all: tooltips.buzzdetectFilterAll, has: tooltips.buzzdetectFilterHas, none: tooltips.buzzdetectFilterNone }}
          onClick={onToggleBuzzdetectFilter}
        />
      ))}
      {/* Over the total column when it's showing (empty while shuffling, which
          has no tree to expand — the slot still keeps the others aligned). */}
      {expandInTotalSlot && slot(true, expandButton)}
    </div>
  );
}
