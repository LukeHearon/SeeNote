import React from 'react';
import { AlertCircle, FolderOpen } from 'lucide-react';
import { openDirectoryDialog, openDirectoryDialogAt } from '../utils/tauriCommands';
import { Project } from '../types';
import { findFirstValidAncestor } from '../utils/helpers';

export type RepairProjectState = {
  project: Project;
  audioMissing: boolean;
  annotationMissing: boolean;
  repairedAudio: string;
  repairedAnnotation: string;
};

function RepairProjectModal({
  repairProject,
  setRepairProject,
  updateProject,
  onOpenProject,
}: {
  repairProject: RepairProjectState;
  setRepairProject: React.Dispatch<React.SetStateAction<RepairProjectState | null>>;
  updateProject: (p: Project) => Promise<void> | void;
  onOpenProject: (p: Project) => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="text-amber-400 flex-none mt-0.5" />
          <div>
            <h3 className="text-white font-semibold text-base">Project directory not found</h3>
            <p className="text-slate-400 text-sm mt-1">
              One or more directories for <span className="text-white">{repairProject.project.name}</span> no longer exist. Please choose new paths.
            </p>
          </div>
        </div>

        {repairProject.audioMissing && (
          <div>
            <label className="text-slate-400 text-xs block mb-1">Audio Directory <span className="text-amber-400">(missing)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repairProject.repairedAudio}
                onChange={e => setRepairProject(r => r ? { ...r, repairedAudio: e.target.value } : r)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e65161]"
              />
              <button
                onClick={async () => {
                  const startDir = await findFirstValidAncestor(repairProject.repairedAudio);
                  const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
                  if (dir) setRepairProject(r => r ? { ...r, repairedAudio: dir } : r);
                }}
                className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
        )}

        {repairProject.annotationMissing && (
          <div>
            <label className="text-slate-400 text-xs block mb-1">Annotation Directory <span className="text-amber-400">(missing)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repairProject.repairedAnnotation}
                onChange={e => setRepairProject(r => r ? { ...r, repairedAnnotation: e.target.value } : r)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e65161]"
              />
              <button
                onClick={async () => {
                  const startDir = await findFirstValidAncestor(repairProject.repairedAnnotation);
                  const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
                  if (dir) setRepairProject(r => r ? { ...r, repairedAnnotation: dir } : r);
                }}
                className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <button
            onClick={() => setRepairProject(null)}
            className="px-4 py-2 text-slate-400 hover:text-white transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              const updated = {
                ...repairProject.project,
                audioDirectory: repairProject.repairedAudio,
                annotationDirectory: repairProject.repairedAnnotation,
              };
              await updateProject(updated);
              setRepairProject(null);
              onOpenProject(updated);
            }}
            className="px-4 py-2 bg-[#e65161] hover:bg-[#f06575] text-white rounded-lg text-sm transition-colors"
          >
            Save & Open
          </button>
        </div>
      </div>
    </div>
  );
}

export default RepairProjectModal;
