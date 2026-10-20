import React, { useEffect, useMemo, useState } from 'react';
import { AudioWaveform, Plus, Settings, Loader2, FolderOpen, FolderSearch, File, Archive, ChevronDown, AlertCircle, Download, ExternalLink, Search, ScrollText } from 'lucide-react';
import { Project, ProjectListEntry, ProjectSettings, RecentFileEntry, RelinkInfo, RelinkResolution } from '../types';
import { revealInFileManager } from '../utils/projectCommands';
import { openDirectoryDialog, openFileDialog } from '../utils/tauriCommands';
import { isInsideProjectDir, basename, dirname } from '../utils/projectPaths';
import { fileManagerLabel } from '../utils/platform';
import { SUPPORTED_AUDIO_EXTS, SUPPORTED_VIDEO_EXTS } from '../constants';
import { launchScreen, openProjectMenu } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { useAppUpdate } from '../hooks/useAppUpdate';
import { APP_VERSION } from '../utils/appVersion';
import { versionBumpType } from '../utils/semver';
import CreateProjectModal from './CreateProjectModal';
import OpenProjectModal from './OpenProjectModal';
import ProjectSettingsModal from './ProjectSettingsModal';
import GradientProjectName from './GradientProjectName';
import ReleaseNotesModal from './ReleaseNotesModal';
import RelinkDialog from './RelinkDialog';
import RecentRow from './RecentRow';
import ConfirmDialog from './ConfirmDialog';
import ContextMenu from './ContextMenu';
import { browseDirectoryNear } from '../utils/dirDialogs';

interface Props {
  entries: ProjectListEntry[];
  isLoading: boolean;
  loadError: string | null;
  projectsFilePath: string | null;
  /** Open a project. `signal` is the one from `beginOpening` when the caller began the open itself. */
  onOpenProject: (project: Project, signal?: AbortSignal) => void;
  /** Show the project-opening view now, before any disk access; aborted if the user backs out. */
  beginOpening: (name: string, nameGradientColors?: [string, string]) => AbortSignal;
  /** Drop the opening view, for an open that won't go ahead. */
  endOpening: (signal: AbortSignal) => void;
  onOpenFile: (path: string) => void;
  createProject: (args: { projectDir: string; settings: ProjectSettings }) => Promise<Project>;
  addExistingProject: (projectDir: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  toggleStarred: (id: string) => Promise<void>;
  relinkProject: (
    id: string,
    newProjectDir: string,
    resolve?: (info: RelinkInfo) => RelinkResolution | Promise<RelinkResolution>,
  ) => Promise<Project | undefined>;
  reconnectProject: (id: string) => Promise<ProjectListEntry | undefined>;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
  fileEntries: RecentFileEntry[];
  isLoadingFiles: boolean;
  removeRecentFile: (id: string) => Promise<void>;
  toggleFileStarred: (id: string) => Promise<void>;
}

type UnifiedEntry =
  | { kind: 'project'; lastOpened: string; entry: ProjectListEntry }
  | { kind: 'file'; lastOpened: string; entry: RecentFileEntry };

export default function LaunchScreen({
  entries,
  isLoading,
  loadError,
  projectsFilePath,
  onOpenProject,
  beginOpening,
  endOpening,
  onOpenFile,
  createProject,
  addExistingProject,
  removeProject,
  toggleStarred,
  relinkProject,
  reconnectProject,
  updateProjectSettings,
  fileEntries,
  isLoadingFiles,
  removeRecentFile,
  toggleFileStarred,
}: Props) {
  const { update, supported, state: updateState, error: updateError, applyUpdate, viewRelease } = useAppUpdate();
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [showOpenProjectMenu, setShowOpenProjectMenu] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectListEntry | null>(null);
  const [showAppSettings, setShowAppSettings] = useState(false);
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
  const closeRelink = (r: RelinkResolution) => {
    setRelinkPrompt(prev => {
      prev?.resolve(r);
      return null;
    });
  };

  useEffect(() => {
    if (!showOpenProjectMenu) return;
    const onDown = () => setShowOpenProjectMenu(false);
    document.body.addEventListener('mousedown', onDown);
    return () => document.body.removeEventListener('mousedown', onDown);
  }, [showOpenProjectMenu]);

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

  const handleOpenFile = async () => {
    setOpenError(null);
    const extensions = [...SUPPORTED_AUDIO_EXTS, ...SUPPORTED_VIDEO_EXTS];
    const path = await openFileDialog(null, [{ name: 'Audio/Video', extensions }]);
    if (!path) return;
    onOpenFile(path);
  };

  // Launch the locate / re-link flow for a single entry: pick a directory,
  // hand it to relinkProject (which gathers dir health, then calls the
  // confirmation modal). Cancelling at either step leaves the entry in its
  // current non-ok state. Used both by the explicit "Re-link" button and as
  // the automatic fall-through when a clicked entry fails validation.
  const launchRelink = async (entry: ProjectListEntry) => {
    setOpenError(null);
    const dir = await browseDirectoryNear(entry.registry.projectDir);
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
    // The opening view goes up before the first read: reconnectProject stats
    // the project folder and reads its settings, which on a sleeping drive is
    // the long wait. It's named from the list's mirrored name and colors.
    const signal = beginOpening(
      entry.registry.name ?? basename(entry.registry.projectDir),
      entry.registry.nameGradientColors,
    );
    const resolved = await reconnectProject(entry.registry.id);
    if (signal.aborted) return;
    if (resolved?.status === 'ok') {
      onOpenProject(resolved.project, signal);
      return;
    }
    endOpening(signal);
    if (!resolved) return;
    const name = resolved.registry.name ?? basename(resolved.registry.projectDir);
    const isBadSettings = resolved.status === 'bad-settings';
    const ok = await askConfirm({
      title: `"${name}" not found`,
      message: isBadSettings
        ? 'The project folder exists but its settings could not be read. You can re-link to a different folder, or cancel.'
        : 'The project folder could not be found at its last known location. You can re-link to a new location, or cancel.',
      confirmLabel: 'Re-link',
    });
    if (!ok) return;
    await launchRelink(resolved);
  };

  const handleRemove = async (e: React.MouseEvent, entry: ProjectListEntry, name: string) => {
    e.stopPropagation();
    const ok = await askConfirm({
      title: `Unlink “${name}”?`,
      message: 'This removes the project from the list. Files in the project folder are not deleted.',
      confirmLabel: 'Unlink',
      danger: true,
    });
    if (ok) await removeProject(entry.registry.id);
  };

  const handleRemoveFile = async (e: React.MouseEvent, file: RecentFileEntry) => {
    e.stopPropagation();
    await removeRecentFile(file.id);
  };

  const handleFileStar = (e: React.MouseEvent, file: RecentFileEntry) => {
    e.stopPropagation();
    toggleFileStarred(file.id).catch(() => {});
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

  const handleStar = (e: React.MouseEvent, entry: ProjectListEntry) => {
    e.stopPropagation();
    toggleStarred(entry.registry.id).catch(() => {});
  };

  const handleContextMenu = (e: React.MouseEvent, entry: ProjectListEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entryId: entry.registry.id });
  };

  const handleShowDataFolder = () => {
    if (!projectsFilePath) return;
    const dir = dirname(projectsFilePath);
    revealInFileManager(dir).catch(() => {
      const appDataDir = dirname(dir);
      revealInFileManager(appDataDir).catch(() => {});
    });
  };

  const fmLabel = fileManagerLabel();
  const appDataRoot = projectsFilePath ? dirname(dirname(projectsFilePath)) : undefined;

  const renderProjectRow = (entry: ProjectListEntry) => {
    const isOk = entry.status === 'ok';
    const isUnchecked = entry.status === 'unchecked';
    // Grayed = we've already tried to resolve this entry and it
    // didn't land cleanly. Unchecked rows look normal — they're
    // assumed-good until the user clicks and we actually check.
    const grayed = !isOk && !isUnchecked;
    const name = isOk
      ? entry.project.settings.projectName
      : (entry.registry.name ?? basename(entry.registry.projectDir));
    const gradientColors = isOk
      ? entry.project.settings.nameGradientColors
      : entry.registry.nameGradientColors;

    let details: React.ReactNode;
    if (entry.status === 'ok') {
      const p = entry.project;
      const mediaInside = isInsideProjectDir(p.projectDir, p.mediaDirectoryAbs);
      const annInside = isInsideProjectDir(p.projectDir, p.annotationDirectoryAbs);
      details = mediaInside && annInside
        ? <p className="text-gray-500 text-xs mt-1 truncate">{p.projectDir}</p>
        : (
          <>
            <p className="text-gray-500 text-xs mt-1 truncate">{launchScreen.mediaPath(p.mediaDirectoryAbs)}</p>
            <p className="text-gray-600 text-xs truncate">{launchScreen.annotationsPath(p.annotationDirectoryAbs)}</p>
          </>
        );
    } else if (entry.status === 'unchecked') {
      details = <p className="text-gray-500 text-xs mt-1 truncate">{entry.registry.projectDir}</p>;
    } else {
      const tag = entry.status === 'missing-dir' ? launchScreen.projectNotFound : launchScreen.projectSettingsUnreadable;
      details = (
        <p className="text-gray-500 text-xs mt-1 truncate">
          {entry.registry.projectDir} <span className="italic">{tag}</span>
        </p>
      );
    }

    return (
      <RecentRow
        key={entry.registry.id}
        title={gradientColors && !grayed
          ? <GradientProjectName name={name} nameGradientColors={gradientColors} />
          : <span className={grayed ? 'text-gray-500' : 'text-gray-200'}>{name}</span>}
        badge={launchScreen.projectBadge}
        badgeClassName="bg-blue-950"
        details={details}
        lastOpened={entry.registry.lastOpened}
        grayed={grayed}
        starred={!!entry.registry.starred}
        onOpen={() => { handleEntryClick(entry).catch(() => {}); }}
        onContextMenu={e => handleContextMenu(e, entry)}
        onToggleStar={e => handleStar(e, entry)}
        onRemove={e => handleRemove(e, entry, name)}
        removeTooltip={tooltips.unlinkProject}
        actions={grayed && (
          <button
            onClick={e => handleLocate(e, entry)}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-md transition-colors"
            data-tooltip={tooltips.relinkProject}
          >
            <FolderSearch size={13} />
            {launchScreen.relinkButton}
          </button>
        )}
        hoverActions={isOk && (
          <button
            onClick={e => handleGear(e, entry)}
            className="text-gray-400 hover:text-white p-1 rounded transition-colors"
            data-tooltip={tooltips.projectSettings}
          >
            <Settings size={15} />
          </button>
        )}
      />
    );
  };

  const renderFileRow = (file: RecentFileEntry) => (
    <RecentRow
      key={file.id}
      title={<span className="text-gray-200">{basename(file.path)}</span>}
      badge={launchScreen.fileBadge}
      badgeClassName="bg-gray-800"
      details={<p className="text-gray-500 text-xs mt-1 truncate">{dirname(file.path)}</p>}
      lastOpened={file.lastOpened}
      starred={!!file.starred}
      onOpen={() => onOpenFile(file.path)}
      onToggleStar={e => handleFileStar(e, file)}
      onRemove={e => handleRemoveFile(e, file)}
      removeTooltip={tooltips.unlinkFile}
    />
  );

  // Re-sorted only when the lists or the search change, not on every render.
  const { starredEntries, unified } = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const nameOf = (item: UnifiedEntry): string =>
      item.kind === 'file'
        ? basename(item.entry.path)
        : (item.entry.registry.name ?? basename(item.entry.registry.projectDir));
    const all: UnifiedEntry[] = [
      ...entries.map((entry): UnifiedEntry => ({ kind: 'project', lastOpened: entry.registry.lastOpened, entry })),
      ...fileEntries.map((file): UnifiedEntry => ({ kind: 'file', lastOpened: file.lastOpened, entry: file })),
    ]
      .filter(item => query === '' || nameOf(item).toLowerCase().includes(query))
      .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
    const isStarred = (item: UnifiedEntry) => !!(item.kind === 'file' ? item.entry.starred : item.entry.registry.starred);
    return { starredEntries: all.filter(isStarred), unified: all.filter(i => !isStarred(i)) };
  }, [entries, fileEntries, searchQuery]);

  const loading = isLoading || isLoadingFiles;

  return (
    <div className="h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3 mb-10 shrink-0">
        <div className="flex items-center gap-3">
          <AudioWaveform size={36} className="text-blue-400" />
          <span className="text-white text-3xl font-semibold tracking-tight">{launchScreen.appName}</span>
        </div>
        <span className="text-gray-500 text-xs">{launchScreen.currentVersion(APP_VERSION)}</span>
        {update && (
          <div className="flex items-center gap-2 pl-3 pr-2 py-1 bg-blue-950/60 border border-blue-800 rounded-full text-xs">
            <span className="text-blue-200">{launchScreen.updateAvailable(versionBumpType(update.current_version, update.version), update.version)}</span>
            {updateState === 'error' && (
              <span className="text-red-400" data-tooltip={updateError ?? undefined}>
                {launchScreen.updateErrorPrefix}
              </span>
            )}
            {supported && (
              <button
                onClick={applyUpdate}
                disabled={updateState === 'installing'}
                className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-wait text-white rounded-full transition-colors"
              >
                {updateState === 'installing' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {updateState === 'installing' ? launchScreen.updatingButton : launchScreen.updateButton}
              </button>
            )}
            <button
              onClick={() => setShowReleaseNotes(true)}
              className="flex items-center gap-1 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-full transition-colors"
            >
              <ScrollText size={11} />
              {launchScreen.viewChangesButton}
            </button>
            <button
              onClick={viewRelease}
              className="flex items-center gap-1 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-full transition-colors"
            >
              <ExternalLink size={11} />
              {launchScreen.viewButton}
            </button>
          </div>
        )}
        {update && showReleaseNotes && (
          <ReleaseNotesModal version={update.version} fallbackNotes={update.notes} onClose={() => setShowReleaseNotes(false)} />
        )}
      </div>

      <div className="w-full max-w-xl flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-gray-300 text-sm font-medium uppercase tracking-wider">{launchScreen.projectsHeading}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenFile}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
            >
              <File size={15} />
              {launchScreen.openFileButton}
            </button>
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); setShowOpenProjectMenu(prev => !prev); }}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              >
                <FolderOpen size={15} />
                {launchScreen.openExistingButton}
                <ChevronDown size={13} />
              </button>
              {showOpenProjectMenu && (
                <div
                  className="absolute z-[70] top-full mt-1 right-0 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-full whitespace-nowrap"
                  onMouseDown={e => e.stopPropagation()}
                >
                  <button
                    onClick={() => { setShowOpenProjectMenu(false); handleOpenExisting().catch(() => {}); }}
                    className="flex items-center gap-2 w-full text-left px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <FolderOpen size={14} />
                    {openProjectMenu.fromFolder}
                  </button>
                  <button
                    onClick={() => { setShowOpenProjectMenu(false); setShowOpenProject(true); }}
                    className="flex items-center gap-2 w-full text-left px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <Archive size={14} />
                    {openProjectMenu.fromArchive}
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
            >
              <Plus size={15} />
              {launchScreen.newProjectButton}
            </button>
            <button
              onClick={() => setShowAppSettings(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              data-tooltip={tooltips.appSettings}
            >
              <Settings size={15} />
              {launchScreen.settingsButton}
            </button>
          </div>
        </div>

        {loadError && (
          <div className="mb-4 shrink-0 flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
            <AlertCircle size={16} className="flex-none mt-0.5" />
            <div>
              <p className="font-medium">{launchScreen.loadError}</p>
              <p className="text-red-400 text-xs mt-1 font-mono">{loadError}</p>
            </div>
          </div>
        )}

        {openError && (
          <div className="mb-4 shrink-0 flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
            <AlertCircle size={16} className="flex-none mt-0.5" />
            <div>
              <p className="font-medium">{launchScreen.openError}</p>
              <p className="text-red-400 text-xs mt-1 font-mono">{openError}</p>
            </div>
          </div>
        )}

        {!loading && (entries.length > 0 || fileEntries.length > 0) && (
          <div className="relative mb-4 shrink-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={launchScreen.searchPlaceholder}
              className="w-full pl-9 pr-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-500 shrink-0">
            <Loader2 size={24} className="animate-spin mr-2" />
            <span className="text-sm">{launchScreen.loadingProjects}</span>
          </div>
        ) : unified.length === 0 && starredEntries.length === 0 ? (
          <div className="border border-dashed border-gray-700 rounded-xl py-16 text-center shrink-0">
            {searchQuery.trim() !== '' ? (
              <p className="text-gray-500 text-sm">{launchScreen.noSearchResults}</p>
            ) : (
              <>
                <p className="text-gray-500 text-sm mb-3">{launchScreen.noProjects}</p>
                <button
                  onClick={() => setShowCreate(true)}
                  className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
                >
                  {launchScreen.createFirstProject}
                </button>
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-2 overflow-y-auto min-h-0 pr-3">
            {starredEntries.map(item =>
              item.kind === 'file' ? renderFileRow(item.entry) : renderProjectRow(item.entry)
            )}
            {starredEntries.length > 0 && unified.length > 0 && (
              <li key="starred-divider" aria-hidden className="border-t border-gray-800 my-1" />
            )}
            {unified.map(item =>
              item.kind === 'file' ? renderFileRow(item.entry) : renderProjectRow(item.entry)
            )}
          </ul>
        )}

        {projectsFilePath && !loading && (
          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={handleShowDataFolder}
              className="flex items-center gap-1.5 text-gray-600 hover:text-gray-400 text-xs transition-colors"
              data-tooltip={tooltips.openDataFolder}
            >
              <FolderOpen size={12} />
              {launchScreen.showDataFolder}
            </button>
            <span className="text-gray-700 text-xs font-mono truncate" data-tooltip={appDataRoot}>
              {appDataRoot}
            </span>
          </div>
        )}
      </div>

      {contextMenu && (() => {
        const entry = entries.find(e => e.registry.id === contextMenu.entryId);
        if (!entry) return null;
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={[{
              label: launchScreen.showInFileManager(fmLabel),
              onSelect: () => { revealInFileManager(entry.registry.projectDir).catch(() => {}); },
            }]}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {showCreate && (
        <CreateProjectModal
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
          createProject={createProject}
          onOpenExisting={async (dir) => {
            const project = await addExistingProject(dir);
            setShowCreate(false);
            onOpenProject(project);
          }}
        />
      )}

      {showOpenProject && (
        <OpenProjectModal
          onClose={() => setShowOpenProject(false)}
          addExistingProject={addExistingProject}
          onOpenProject={onOpenProject}
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

      {showAppSettings && (
        <ProjectSettingsModal onClose={() => setShowAppSettings(false)} />
      )}

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          icon={<AlertCircle size={20} className="text-amber-400" />}
          actions={[
            { label: launchScreen.cancelButton, onClick: () => closeConfirm(false) },
            { label: confirmState.confirmLabel, onClick: () => closeConfirm(true), tone: confirmState.danger ? 'danger' : 'primary' },
          ]}
          onDismiss={() => closeConfirm(false)}
        >
          {confirmState.bullets && confirmState.bullets.length > 0 && (
            <ul className="space-y-1.5 text-sm text-gray-300 list-disc pl-9">
              {confirmState.bullets.map((b, i) => (
                <li key={i} className="whitespace-pre-wrap break-words">{b}</li>
              ))}
            </ul>
          )}
        </ConfirmDialog>
      )}

      {relinkPrompt && <RelinkDialog info={relinkPrompt} onResolve={closeRelink} />}
    </div>
  );
}
