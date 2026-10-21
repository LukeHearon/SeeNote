import { ArrowLeft, Bug, HelpCircle, Keyboard, RefreshCw, Settings } from 'lucide-react';
import GradientProjectName from './GradientProjectName';
import SyncControls from './SyncControls';
import { tooltips } from '../copy/tooltips';
import { debugConsole } from '../copy/ui';
import { showHelpPage } from '../utils/helpChannel';

interface Props {
  name: string;
  nameGradientColors?: [string, string] | null;
  onClose: () => void;
  /** The project-scoped actions. Absent while the project is still opening,
   *  which leaves their buttons in place but disabled. */
  onRefreshAll?: () => void;
  onOpenProjectSettings?: () => void;
  onOpenDebug?: () => void;
  /** Sync state, or null when the project has no git sync configured. */
  sync: {
    remoteUrl: string;
    syncing: boolean;
    hasLocalChanges: boolean;
    hasRemoteChanges: boolean;
    onSync: (message?: string) => void;
  } | null;
}

/** The annotation window's header: back, refresh, project name/settings, sync, debug, help. */
export default function ProjectHeader({ name, nameGradientColors, onClose, onRefreshAll, onOpenProjectSettings, onOpenDebug, sync }: Props) {
  return (
    <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative" data-help-target="toolbar">
      <div className="flex items-center space-x-4">
          <button
              onClick={onClose}
              className="flex items-center space-x-1 text-slate-400 hover:text-white hover:bg-slate-700 px-2 py-1.5 rounded transition-colors"
              data-tooltip={tooltips.backToProjects}
          >
              <ArrowLeft size={18} />
          </button>
          <button
              onClick={onRefreshAll}
              disabled={!onRefreshAll}
              className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              data-tooltip={tooltips.refreshAll}
              data-help-target="header-refresh-btn"
          >
              <RefreshCw size={18} />
          </button>
          <button
              onClick={onOpenProjectSettings}
              disabled={!onOpenProjectSettings}
              className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-slate-700 transition-colors group disabled:pointer-events-none"
              data-tooltip={tooltips.projectSettings}
              data-help-target="project-settings-btn"
          >
              <h1 className="text-xl font-bold">
                  <GradientProjectName name={name} nameGradientColors={nameGradientColors} />
              </h1>
              <Settings size={15} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
          </button>
      </div>

      <div />

      <div className="flex items-center space-x-3">
           {sync && <SyncControls {...sync} />}
           <button
              onClick={onOpenDebug}
              disabled={!onOpenDebug}
              className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-40 disabled:pointer-events-none"
              data-tooltip={debugConsole.title}
          >
              <Bug size={18} />
          </button>
           <button
              onClick={() => showHelpPage()}
              className="p-2 rounded hover:bg-slate-700 transition-colors text-slate-400 hover:text-white"
              data-tooltip={tooltips.helpGuide}
          >
              <HelpCircle size={18} />
          </button>
           <button
              onClick={() => showHelpPage('shortcuts')}
              className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
              data-tooltip={tooltips.keyboardShortcuts}
          >
              <Keyboard size={18} />
          </button>
      </div>
    </header>
  );
}
