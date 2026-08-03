import { AlignJustify, Eye, EyeOff, Filter, FoldVertical, RefreshCw, Shuffle, UnfoldVertical } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';

export type FileFilter = 'all' | 'annotated' | 'unannotated';

export interface FilePanelHeaderButtonsProps {
  /** Hides the expand/collapse button — shuffle mode has no folder tree. */
  shuffleMode: boolean;
  /** Whether any folder is open, which is what the expand/collapse button flips. */
  anyExpanded: boolean;
  fileFilter: FileFilter;
  onToggleExpandCollapse: () => void;
  onRefresh: () => void;
  onToggleFileFilter: () => void;
  onToggleShuffle: () => void;
}

/**
 * The button cluster on the right of the file panel's header. Extracted from
 * FileTree so the help guide can render a working copy (components/help/
 * LiveControls.tsx) instead of describing four icons in prose.
 */
export function FilePanelHeaderButtons({
  shuffleMode,
  anyExpanded,
  fileFilter,
  onToggleExpandCollapse,
  onRefresh,
  onToggleFileFilter,
  onToggleShuffle,
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
      <button
        onClick={onRefresh}
        className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
        data-tooltip={tooltips.refreshFileList}
      >
        <RefreshCw size={13} />
      </button>
      <button
        onClick={onToggleFileFilter}
        className={`p-1 rounded hover:bg-slate-700 ${fileFilter !== 'all' ? 'text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
        data-tooltip={fileFilter === 'all' ? tooltips.showAllFiles : fileFilter === 'unannotated' ? tooltips.showingUnannotated : tooltips.showingAnnotated}
      >
        {fileFilter === 'all' ? <Eye size={13} /> : fileFilter === 'unannotated' ? <EyeOff size={13} /> : <Filter size={13} />}
      </button>
      <button
        onClick={onToggleShuffle}
        className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
        data-tooltip={shuffleMode ? tooltips.switchToSorted : tooltips.shuffleQueue}
      >
        {shuffleMode ? <AlignJustify size={13} /> : <Shuffle size={13} />}
      </button>
    </div>
  );
}
