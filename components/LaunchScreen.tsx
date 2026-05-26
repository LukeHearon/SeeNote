import React, { useEffect, useState } from 'react';
import { AudioWaveform, Plus, Settings, Loader2, X, FolderOpen, FolderSearch, AlertCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Project, ProjectListEntry, ProjectSettings, RelinkInfo, RelinkResolution } from '../types';
import { revealInFileManager } from '../utils/projectCommands';
import { openDirectoryDialog, openDirectoryDialogAt } from '../utils/tauriCommands';
import { isInsideProjectDir, basename } from '../utils/projectPaths';
import { findFirstValidAncestor } from '../utils/helpers';
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
  relinkProject: (
    id: string,
    newProjectDir: string,
    resolve?: (info: RelinkInfo) => RelinkResolution | Promise<RelinkResolution>,
  ) => Promise<Project | undefined>;
  reconnectProject: (id: string) => Promise<ProjectListEntry | undefined>;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
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
  relinkProject,
  reconnectProject,
  updateProjectSettings,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectListEntry | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);
  // In-app confirmation dialog. We can't use the browser `confirm()` here: in
  // the packaged app it routes through Tauri's dialog plugin, which isn't
  // permitted, and it renders multi-line content poorly. `askConfirm` returns a
  // promise that resolves when the user picks an action.
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message?: string;
    bullets?: string[];
    confirmLabel: string;
    danger?: boolean;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const askConfirm = (opts: {
    title: string;
    message?: string;
    bullets?: string[];
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean> =>
    new Promise(resolve => setConfirmState({ ...opts, resolve }));

  const closeConfirm = (ok: boolean) => {
    setConfirmState(prev => {
      prev?.resolve(ok);
      return null;
    });
  };

  // Re-link confirmation: shows the directory health of the chosen folder and,
  // when the on-disk name disagrees with SeeNote's, lets the user pick which to
  // keep. Promise-based like askConfirm.
  const [relinkPrompt, setRelinkPrompt] = useState<
    (RelinkInfo & { resolve: (r: RelinkResolution) => void }) | null
  >(null);
  // When the on-disk name disagrees, the user readies one of the two names
  // before committing the re-link; null means no choice made yet.
  const [readyName, setReadyName] = useState<string | null>(null);
  // User-browsed paths for missing dirs, keyed by RelinkDirStatus.label.
  const [dirOverrides, setDirOverrides] = useState<Record<string, string>>({});

  const closeRelink = (r: RelinkResolution) => {
    setRelinkPrompt(prev => {
      prev?.resolve(r);
      return null;
    });
    setReadyName(null);
    setDirOverrides({});
  };

  const handleBrowseMissingDir = async (label: string, currentPath: string) => {
    const startDir = await findFirstValidAncestor(currentPath).catch(() => '');
    const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
    if (dir) setDirOverrides(prev => ({ ...prev, [label]: dir }));
  };

  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    document.body.addEventListener('mousedown', onDown);
    return () => document.body.removeEventListener('mousedown', onDown);
  }, [contextMenu]);

  // No background re-validation: see useProjects.ts for the rationale —
  // proactively stat'ing registered projects costs macOS TCC consent prompts.
  // Entries are validated lazily on click via reconnectProject.

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

  // Launch the locate / re-link flow for a single entry: pick a directory,
  // hand it to relinkProject (which gathers dir health, then calls the
  // confirmation modal). Cancelling at either step leaves the entry in its
  // current non-ok state. Used both by the explicit "Re-link" button and as
  // the automatic fall-through when a clicked entry fails validation.
  const launchRelink = async (entry: ProjectListEntry) => {
    setOpenError(null);
    const startDir = await findFirstValidAncestor(entry.registry.projectDir).catch(() => '');
    const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
    if (!dir) return;
    try {
      const project = await relinkProject(entry.registry.id, dir, info =>
        new Promise<RelinkResolution>(resolve => setRelinkPrompt({ ...info, resolve })),
      );
      if (project) onOpenProject(project);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  };

  // Every row is clickable. We validate against disk lazily here — that one
  // read may trigger a macOS TCC consent prompt the first time, but doing it
  // on click (rather than for every registered project on launch) keeps the
  // user from being swamped. If the entry resolves cleanly the project opens;
  // otherwise the locate / re-link flow fires automatically and the row is
  // left grayed out until the user successfully re-links it.
  const handleEntryClick = async (entry: ProjectListEntry) => {
    setOpenError(null);
    const resolved = await reconnectProject(entry.registry.id);
    if (!resolved) return;
    if (resolved.status === 'ok') {
      onOpenProject(resolved.project);
      return;
    }
    await launchRelink(resolved);
  };

  const handleRemove = async (e: React.MouseEvent, entry: ProjectListEntry, name: string) => {
    e.stopPropagation();
    const ok = await askConfirm({
      title: `Remove “${name}”?`,
      message: 'This removes the project from the list. Files in the project folder are not deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await removeProject(entry.registry.id);
  };

  // Re-link button on a non-ok row. Same flow as launchRelink — the button is
  // kept as an explicit affordance, but row-click handles the same case.
  const handleLocate = async (e: React.MouseEvent, entry: ProjectListEntry) => {
    e.stopPropagation();
    await launchRelink(entry);
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
              const isUnchecked = entry.status === 'unchecked';
              // Grayed = we've already tried to resolve this entry and it
              // didn't land cleanly. Unchecked rows look normal — they're
              // assumed-good until the user clicks and we actually check.
              const grayed = !isOk && !isUnchecked;
              const name = isOk
                ? entry.project.settings.name
                : (entry.registry.name ?? basename(entry.registry.projectDir));
              const gradientColors = isOk ? entry.project.settings.nameGradientColors : undefined;
              const liClass = grayed
                ? 'group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all text-gray-500 opacity-50'
                : 'group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all';

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
              } else if (entry.status === 'unchecked') {
                pathLines = (
                  <p className="text-gray-500 text-xs mt-1 truncate">{entry.registry.projectDir}</p>
                );
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
                  onClick={() => { handleEntryClick(entry).catch(() => {}); }}
                  onContextMenu={e => handleContextMenu(e, entry)}
                  className={liClass}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-bold truncate">
                        {isOk ? (
                          <GradientProjectName name={name} nameGradientColors={gradientColors} />
                        ) : (
                          <span className={grayed ? 'text-gray-500' : 'text-gray-200'}>{name}</span>
                        )}
                      </p>
                      {pathLines}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {grayed && (
                        <button
                          onClick={e => handleLocate(e, entry)}
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-md transition-colors"
                          data-tooltip="Find this project's folder on disk and re-link it"
                        >
                          <FolderSearch size={13} />
                          Re-link
                        </button>
                      )}
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
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

      {confirmState && (
        <div
          className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-4"
          onMouseDown={() => closeConfirm(false)}
        >
          <div
            className="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl w-full max-w-lg p-6 space-y-4"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-amber-400 flex-none mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-white font-semibold text-base">{confirmState.title}</h3>
                {confirmState.message && (
                  <p className="text-gray-400 text-sm mt-1">{confirmState.message}</p>
                )}
              </div>
            </div>

            {confirmState.bullets && confirmState.bullets.length > 0 && (
              <ul className="space-y-1.5 text-sm text-gray-300 list-disc pl-9">
                {confirmState.bullets.map((b, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words">{b}</li>
                ))}
              </ul>
            )}

            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => closeConfirm(false)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => closeConfirm(true)}
                className={
                  confirmState.danger
                    ? 'px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm transition-colors'
                    : 'px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors'
                }
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {relinkPrompt && (
        <div
          className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-4"
          onMouseDown={() => closeRelink({ action: 'cancel' })}
        >
          <div
            className="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl w-full max-w-lg p-6 space-y-4"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <FolderSearch size={20} className="text-blue-400 flex-none mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-white font-semibold text-base">Re-link this project?</h3>
                <p className="text-gray-400 text-sm mt-1">Here's what's in the folder you selected:</p>
              </div>
            </div>

            <ul className="space-y-2 text-sm">
              {relinkPrompt.dirs.map(d => {
                const located = !!dirOverrides[d.label];
                const resolved = d.exists || located;
                return (
                  <li key={d.label} className="flex items-start gap-2">
                    {resolved
                      ? <CheckCircle2 size={16} className="text-emerald-400 flex-none mt-0.5" />
                      : <AlertTriangle size={16} className="text-amber-400 flex-none mt-0.5" />}
                    <span className="min-w-0">
                      <span className="text-gray-200">{d.label}</span>{' '}
                      <span className={resolved ? 'text-emerald-400' : 'text-amber-400'}>
                        {resolved ? 'found' : 'missing'}
                      </span>
                      <span className="block text-gray-500 text-xs break-words">
                        {dirOverrides[d.label] ?? d.path}
                      </span>
                      {!d.exists && (
                        <button
                          onClick={() => handleBrowseMissingDir(d.label, d.path)}
                          className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-md transition-colors"
                        >
                          <FolderOpen size={13} />
                          Locate
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}

              {relinkPrompt.nameConflict && (
                <li className="flex items-center gap-2 flex-wrap">
                  {readyName !== null
                    ? <CheckCircle2 size={16} className="text-emerald-400 flex-none" />
                    : <AlertTriangle size={16} className="text-amber-400 flex-none" />}
                  <span className="min-w-0">
                    <span className="text-gray-200">Name</span>{' '}
                    <span className={readyName !== null ? 'text-emerald-400' : 'text-amber-400'}>
                      {readyName !== null ? 'selected' : 'differs'}
                    </span>
                  </span>
                  <button
                    onClick={() => setReadyName(relinkPrompt.internalName)}
                    className={
                      'px-3 py-1 rounded-lg text-sm transition-colors max-w-[12rem] truncate ' +
                      (readyName === relinkPrompt.internalName
                        ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                        : 'bg-gray-700 hover:bg-gray-600 text-gray-200')
                    }
                    data-tooltip="Keep SeeNote's name (rewrites .seenote/settings.json)"
                  >
                    “{relinkPrompt.internalName}”
                  </button>
                  <button
                    onClick={() => setReadyName(relinkPrompt.settingsName)}
                    className={
                      'px-3 py-1 rounded-lg text-sm transition-colors max-w-[12rem] truncate ' +
                      (readyName === relinkPrompt.settingsName
                        ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                        : 'bg-gray-700 hover:bg-gray-600 text-gray-200')
                    }
                    data-tooltip="Use the name from the folder's .seenote/settings.json"
                  >
                    “{relinkPrompt.settingsName}”
                  </button>
                </li>
              )}
            </ul>

            <div className="flex gap-3 justify-end pt-1">
              <button
                onClick={() => closeRelink({ action: 'cancel' })}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
              >
                Cancel
              </button>
              {(() => {
                const requiredDirs = relinkPrompt.dirs.filter(d => d.label !== 'buzzdetect');
                const allRequiredFound = requiredDirs.every(d => d.exists || !!dirOverrides[d.label]);
                const nameReady = !relinkPrompt.nameConflict || readyName !== null;
                const canRelink = allRequiredFound && nameReady;
                return (
                  <button
                    disabled={!canRelink}
                    onClick={() =>
                      closeRelink({
                        action: 'relink',
                        name: relinkPrompt.nameConflict ? readyName! : relinkPrompt.settingsName,
                        dirOverrides: Object.keys(dirOverrides).length ? dirOverrides : undefined,
                      })
                    }
                    className={
                      !canRelink
                        ? 'px-4 py-2 bg-gray-700 text-gray-500 rounded-lg text-sm cursor-not-allowed'
                        : 'px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors'
                    }
                  >
                    Re-link
                  </button>
                );
              })()}

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
