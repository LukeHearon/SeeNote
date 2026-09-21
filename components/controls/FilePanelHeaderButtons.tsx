import { Activity, FoldVertical, StickyNote, UnfoldVertical } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';
import type { FileFilter } from '../../utils/fileFilter';
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
}: FilePanelHeaderButtonsProps) {
  return (
    <div className="flex items-center gap-0.5 flex-none" data-help-target="file-panel-header">
      {!shuffleMode && (
        <button
          onClick={onToggleExpandCollapse}
          className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          data-tooltip={anyExpanded ? tooltips.collapseAll : tooltips.expandAll}
        >
          {anyExpanded ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
        </button>
      )}
      <PresenceFilterButton
        icon={StickyNote}
        state={fileFilter}
        tooltips={{ all: tooltips.annotationFilterAll, has: tooltips.annotationFilterHas, none: tooltips.annotationFilterNone }}
        onClick={onToggleFileFilter}
      />
      {showBuzzdetect && (
        <PresenceFilterButton
          icon={Activity}
          state={buzzdetectFilter}
          tooltips={{ all: tooltips.buzzdetectFilterAll, has: tooltips.buzzdetectFilterHas, none: tooltips.buzzdetectFilterNone }}
          onClick={onToggleBuzzdetectFilter}
        />
      )}
    </div>
  );
}
