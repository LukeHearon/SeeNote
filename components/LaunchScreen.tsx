import React, { useEffect, useState } from 'react';
import { AudioWaveform, Plus, Settings, Loader2, X, FolderOpen, AlertCircle } from 'lucide-react';
import { Project, ProjectListEntry, ProjectSettings } from '../types';
import { revealInFileManager } from '../utils/projectCommands';
import { openDirectoryDialog } from '../utils/tauriCommands';
import { isInsideProjectDir } from '../utils/projectPaths';
import CreateProjectModal from './CreateProjectModal';
import ProjectSettingsModal from './ProjectSettingsModal';
import GradientProjectName from './GradientProjectName';

interface Props {
  entries: ProjectListEntry[];
  isLoading: boolean;
  loadError: string | null;
  projectsFilePath: string | null;
  onOpenProject: (project: Project) => void;
  createProject: (args: { projectDir: string; settings: ProjectSettings }) => Promise<Project>;
  addExistingProject: (projectDir: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  reconnectProject: (id: string) => Promise<ProjectListEntry | undefined>;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
}

function basename(p: string): string {
  const stripped = p.replace(/[/\\]+$/, '');
  const idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return idx >= 0 ? stripped.slice(idx + 1) : stripped;
}

function fileManagerLabel(): string {
  const plat = (typeof navigator !== 'undefined' && navigator.platform) ? navigator.platform : '';
  if (/Mac/i.test(plat)) return 'Finder';
  if (/Win/i.test(plat)) return 'Explorer';
  return 'file manager';
}

export default function LaunchScreen({
  entries,
  isLoading,
  loadError,
  projectsFilePath,
  onOpenProject,
  createProject,
  addExistingProject,
  removeProject,
  reconnectProject,
  updateProjectSettings,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectListEntry | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    document.body.addEventListener('mousedown', onDown);
    return () => document.body.removeEventListener('mousedown', onDown);
  }, [contextMenu]);

  const handleCreated = (project: Project) => {
    setShowCreate(false);
    onOpenProject(project);
  };

  const handleOpenExisting = async () => {
    setOpenError(null);
    const dir = await openDirectoryDialog();
    if (!dir) return;
    try {
      const project = await addExistingProject(dir);
      onOpenProject(project);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEntryClick = async (entry: ProjectListEntry) => {
    if (entry.status === 'ok') {
      onOpenProject(entry.project);
      return;
    }
    const returned = await reconnectProject(entry.registry.id);
    if (returned && returned.status === 'ok') {
      onOpenProject(returned.project);
      return;
    }
    const message = entry.status === 'missing-dir'
      ? `Project folder not found at\n${entry.registry.projectDir}\n\nRemove from list?`
      : `Project folder found at\n${entry.registry.projectDir}\nbut .seenote/settings.json could not be read.\n\nRemove from list?`;
    if (confirm(message)) {
      await removeProject(entry.registry.id);
    }
  };

  const handleRemove = async (e: React.MouseEvent, entry: ProjectListEntry, name: string) => {
    e.stopPropagation();
    if (confirm(`Remove "${name}" from the list? Files in the project folder are not deleted.`)) {
      await removeProject(entry.registry.id);
    }
  };

  const handleGear = (e: React.MouseEvent, entry: ProjectListEntry) => {
    e.stopPropagation();
    setEditingEntry(entry);
  };

  const handleContextMenu = (e: React.MouseEvent, entry: ProjectListEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entryId: entry.registry.id });
  };

  const handleShowDataFolder = () => {
    if (!projectsFilePath) return;
    const dir = projectsFilePath.substring(0, projectsFilePath.lastIndexOf('/'));
    revealInFileManager(dir).catch(() => {
      const appDataDir = dir.substring(0, dir.lastIndexOf('/'));
      revealInFileManager(appDataDir).catch(() => {});
    });
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  const fmLabel = fileManagerLabel();

  return (
    <div className="h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
      <div className="flex items-center gap-3 mb-10 shrink-0">
        <AudioWaveform size={36} className="text-blue-400" />
        <span className="text-white text-3xl font-semibold tracking-tight">SeeNote</span>
      </div>

      <div className="w-full max-w-xl flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-gray-300 text-sm font-medium uppercase tracking-wider">Projects</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenExisting}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
            >
              <FolderOpen size={15} />
              Open Existing Project
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
            >
              <Plus size={15} />
              New Project
            </button>
          </div>
        </div>

        {loadError && (
          <div className="mb-4 shrink-0 flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
            <AlertCircle size={16} className="flex-none mt-0.5" />
            <div>
              <p className="font-medium">Failed to load projects</p>
              <p className="text-red-400 text-xs mt-1 font-mono">{loadError}</p>
            </div>
          </div>
        )}

        {openError && (
          <div className="mb-4 shrink-0 flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
            <AlertCircle size={16} className="flex-none mt-0.5" />
            <div>
              <p className="font-medium">Could not open project</p>
              <p className="text-red-400 text-xs mt-1 font-mono">{openError}</p>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-500 shrink-0">
            <Loader2 size={24} className="animate-spin mr-2" />
            <span className="text-sm">Loading projects…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="border border-dashed border-gray-700 rounded-xl py-16 text-center shrink-0">
            <p className="text-gray-500 text-sm mb-3">No projects yet.</p>
            <button
              onClick={() => setShowCreate(true)}
              className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <ul className="space-y-2 overflow-y-auto min-h-0 pr-3">
            {entries.map(entry => {
              const isOk = entry.status === 'ok';
              const name = isOk ? entry.project.settings.name : basename(entry.registry.projectDir);
              const gradientColors = isOk ? entry.project.settings.nameGradientColors : undefined;
              const liClass = isOk
                ? 'group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all'
                : 'group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all text-gray-500 opacity-50';

              let pathLines: React.ReactNode = null;
              if (entry.status === 'ok') {
                const p = entry.project;
                const mediaInside = isInsideProjectDir(p.projectDir, p.mediaDirectoryAbs);
                const annInside = isInsideProjectDir(p.projectDir, p.annotationDirectoryAbs);
                if (mediaInside && annInside) {
                  pathLines = (
                    <p className="text-gray-500 text-xs mt-1 truncate">{p.projectDir}</p>
                  );
                } else {
                  pathLines = (
                    <>
                      <p className="text-gray-500 text-xs mt-1 truncate">Media: {p.mediaDirectoryAbs}</p>
                      <p className="text-gray-600 text-xs truncate">Annotations: {p.annotationDirectoryAbs}</p>
                    </>
                  );
                }
              } else {
                const tag = entry.status === 'missing-dir' ? '(not found)' : '(settings unreadable)';
                pathLines = (
                  <p className="text-gray-500 text-xs mt-1 truncate">
                    {entry.registry.projectDir} <span className="italic">{tag}</span>
                  </p>
                );
              }

              return (
                <li
                  key={entry.registry.id}
                  onClick={() => handleEntryClick(entry)}
                  onContextMenu={e => handleContextMenu(e, entry)}
                  className={liClass}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-bold truncate">
                        <GradientProjectName name={name} nameGradientColors={gradientColors} />
                      </p>
                      {pathLines}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {isOk && (
                        <button
                          onClick={e => handleGear(e, entry)}
                          className="text-gray-400 hover:text-white p-1 rounded transition-colors"
                          data-tooltip="Project settings"
                        >
                          <Settings size={15} />
                        </button>
                      )}
                      <button
                        onClick={e => handleRemove(e, entry, name)}
                        className="text-gray-400 hover:text-red-400 p-1 rounded transition-colors"
                        data-tooltip="Remove project"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                  <p className="text-gray-600 text-xs mt-2">
                    Last opened {formatDate(entry.registry.lastOpened)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}

        {projectsFilePath && !isLoading && (
          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={handleShowDataFolder}
              className="flex items-center gap-1.5 text-gray-600 hover:text-gray-400 text-xs transition-colors"
              data-tooltip="Open the folder where projects are stored"
            >
              <FolderOpen size={12} />
              Show data folder
            </button>
            <span className="text-gray-700 text-xs font-mono truncate" data-tooltip={projectsFilePath}>
              {projectsFilePath}
            </span>
          </div>
        )}
      </div>

      {contextMenu && (() => {
        const entry = entries.find(e => e.registry.id === contextMenu.entryId);
        if (!entry) return null;
        return (
          <div
            className="absolute z-[70] bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onMouseDown={e => e.stopPropagation()}
          >
            <button
              onClick={() => {
                revealInFileManager(entry.registry.projectDir).catch(() => {});
                setContextMenu(null);
              }}
              className="block w-full text-left px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
            >
              Show project in {fmLabel}
            </button>
          </div>
        );
      })()}

      {showCreate && (
        <CreateProjectModal
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
          createProject={createProject}
        />
      )}

      {editingEntry && editingEntry.status === 'ok' && (
        <ProjectSettingsModal
          project={editingEntry.project}
          onSave={async (settings) => {
            await updateProjectSettings(editingEntry.project.id, settings);
            setEditingEntry(null);
          }}
          onClose={() => setEditingEntry(null)}
        />
      )}
    </div>
  );
}
