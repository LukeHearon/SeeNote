import React, { useState, useRef, useEffect } from 'react';
import { FolderOpen, HelpCircle } from 'lucide-react';
import { createProjectModal } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { Project, ProjectSettings, ProjectPreferences } from '../types';
import { openDirectoryDialog, checkDirExists, createDirAll, createAnnotationTool, openSyncGuideWindow } from '../utils/tauriCommands';
import { readProjectSettings, writeProjectPreferences } from '../utils/projectCommands';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_TOOL_SEED, randomMagmaGradient } from '../constants';
import { buildHotkeyMap } from '../utils/annotationTools';
import { makeProjectPath, resolveInputPath } from '../utils/projectPaths';
import { normalizeGitRemoteUrl, applySyncToken, type TokenStorage } from '../utils/gitSync';
import SettingsModalShell from './SettingsModalShell';
import ProjectBaseFields from './ProjectBaseFields';
import GitSyncUserFields from './GitSyncUserFields';

interface Props {
  onCreated: (project: Project) => void;
  onClose: () => void;
  createProject: (args: { projectDir: string; settings: ProjectSettings }) => Promise<Project>;
  onOpenExisting?: (projectDir: string) => Promise<void>;
}

export default function CreateProjectModal({ onCreated, onClose, createProject, onOpenExisting }: Props) {
  const [projectDir, setProjectDir] = useState('');
  const [name, setName] = useState('');
  const [mediaDir, setMediaDir] = useState('');
  const [annotationDir, setAnnotationDir] = useState('');
  const [buzzdetectDir, setBuzzdetectDir] = useState('');
  const [outputRoundingDecimals, setOutputRoundingDecimals] = useState(DEFAULT_OUTPUT_ROUNDING_DECIMALS);
  const [gradientColors, setGradientColors] = useState<[string, string]>(() => randomMagmaGradient());
  const [syncRemoteUrl, setSyncRemoteUrl] = useState('');
  const [syncToken, setSyncToken] = useState('');
  const [syncTokenStorage, setSyncTokenStorage] = useState<TokenStorage>('keychain');
  const [syncAuthorName, setSyncAuthorName] = useState('');
  const [activeTab, setActiveTab] = useState<'settings' | 'preferences'>('settings');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [existingProjectName, setExistingProjectName] = useState<string | null>(null);

  const nameTouchedRef = useRef(false);
  const mediaTouchedRef = useRef(false);
  const annotationTouchedRef = useRef(false);

  const resolvedMediaDir = resolveInputPath(projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(projectDir, annotationDir);
  const resolvedBuzzdetectDir = resolveInputPath(projectDir, buzzdetectDir);

  useEffect(() => {
    if (!projectDir) return;
    const base = projectDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
    if (!nameTouchedRef.current) setName(base);
    if (!annotationTouchedRef.current) setAnnotationDir('annotations');
    if (!mediaTouchedRef.current) {
      const root = projectDir.replace(/[/\\]+$/, '');
      Promise.all([checkDirExists(root + '/media'), checkDirExists(root + '/audio')]).then(
        ([hasMedia, hasAudio]) => {
          if (mediaTouchedRef.current) return;
          if (hasMedia) setMediaDir('media');
          else if (hasAudio) setMediaDir('audio');
        },
      );
    }
  }, [projectDir]);

  const checkExistingProject = async (dir: string) => {
    if (!dir) { setExistingProjectName(null); return; }
    try {
      const existing = await readProjectSettings(dir);
      setExistingProjectName(existing.projectName);
    } catch {
      setExistingProjectName(null);
    }
  };

  const handleBrowseProject = async () => {
    const dir = await openDirectoryDialog();
    if (dir) { setProjectDir(dir); checkExistingProject(dir); }
  };

  const handleCreate = async () => {
    if (!projectDir) { setError(createProjectModal.errorDirRequired); return; }
    if (!name.trim()) { setError(createProjectModal.errorNameRequired); return; }
    if (!mediaDir) { setError(createProjectModal.errorMediaRequired); return; }
    if (!annotationDir) { setError(createProjectModal.errorAnnotationsRequired); return; }

    setError('');
    setIsCreating(true);

    try {
      await createDirAll(projectDir);
    } catch (err) {
      setError(String(err));
      setIsCreating(false);
      return;
    }

    try {
      const existing = await readProjectSettings(projectDir);
      setExistingProjectName(existing.projectName);
      setError(createProjectModal.errorAlreadyExists(existing.projectName));
      setIsCreating(false);
      return;
    } catch {
      setExistingProjectName(null);
    }

    try {
      await createDirAll(resolvedMediaDir);
      await createDirAll(resolvedAnnotationDir);
      const normalizedSyncRemoteUrl = normalizeGitRemoteUrl(syncRemoteUrl);

      const tokenFields = normalizedSyncRemoteUrl
        ? await applySyncToken(normalizedSyncRemoteUrl, syncTokenStorage, syncToken.trim() || null)
        : {};

      const settings: ProjectSettings = {
        projectName: name.trim(),
        mediaDirectory: makeProjectPath(projectDir, resolvedMediaDir),
        annotationDirectory: makeProjectPath(projectDir, resolvedAnnotationDir),
        buzzdetectDirectory: buzzdetectDir ? makeProjectPath(projectDir, resolvedBuzzdetectDir) : undefined,
        outputFormat: 'txt',
        outputRoundingDecimals,
        nameGradientColors: gradientColors,
        gitSync: normalizedSyncRemoteUrl ? { remoteUrl: normalizedSyncRemoteUrl } : undefined,
      };
      const project = await createProject({ projectDir, settings });

      const prefs: ProjectPreferences = {
        toolHotkeys: buildHotkeyMap(DEFAULT_TOOL_SEED),
        ...(normalizedSyncRemoteUrl ? {
          gitSyncUser: { authorName: syncAuthorName.trim() || undefined, ...tokenFields },
        } : {}),
      };
      await writeProjectPreferences(projectDir, prefs);

      for (const t of DEFAULT_TOOL_SEED) {
        if (t.key === '0') continue;
        await createAnnotationTool(projectDir, t.text, t.color, t.description ?? '');
      }
      onCreated(project);
    } catch (err) {
      setError(String(err));
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <SettingsModalShell
        title={createProjectModal.title}
        onClose={onClose}
        tabs={[
          { label: createProjectModal.tabSettings, active: activeTab === 'settings', onClick: () => setActiveTab('settings') },
          { label: createProjectModal.tabPreferences, active: activeTab === 'preferences', onClick: () => setActiveTab('preferences') },
        ]}
        footer={
          <>
            {error && <p className="text-red-400 text-sm flex-1 self-center">{error}</p>}
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
              {createProjectModal.cancelButton}
            </button>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isCreating ? createProjectModal.creatingButton : createProjectModal.createButton}
            </button>
          </>
        }
      >
        {activeTab === 'settings' && (
          <>
            <div>
              <label className="text-gray-400 text-sm block mb-1">{createProjectModal.projectDirLabel}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={projectDir}
                  onChange={e => { setProjectDir(e.target.value); setExistingProjectName(null); }}
                  onBlur={e => checkExistingProject(e.target.value)}
                  placeholder={createProjectModal.projectDirPlaceholder}
                  className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <button
                  onClick={handleBrowseProject}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
                >
                  <FolderOpen size={16} />
                </button>
              </div>
              {existingProjectName && (
                <div className="flex items-start gap-2 mt-1">
                  <p className="text-red-400 text-xs flex-1">
                    {createProjectModal.infoAlreadyExists(existingProjectName!)}
                  </p>
                  {onOpenExisting && (
                    <button
                      onClick={() => onOpenExisting(projectDir)}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-md transition-colors shrink-0"
                    >
                      {createProjectModal.openExistingButton}
                    </button>
                  )}
                </div>
              )}
            </div>

            <ProjectBaseFields
              projectDir={projectDir}
              name={name}
              onNameInput={n => { nameTouchedRef.current = true; setName(n); }}
              gradientColors={gradientColors}
              onGradientChange={setGradientColors}
              mediaDir={mediaDir}
              onMediaDirChange={v => { mediaTouchedRef.current = true; setMediaDir(v); }}
              mediaDirPlaceholder={projectDir ? 'media' : '/path/to/media'}
              mediaDirNotExistMessage={createProjectModal.infoDirWillBeCreated}
              annotationDir={annotationDir}
              onAnnotationDirChange={v => { annotationTouchedRef.current = true; setAnnotationDir(v); }}
              annotationDirPlaceholder={projectDir ? 'annotations' : '/path/to/annotations'}
              annotationDirNotExistMessage={createProjectModal.infoDirWillBeCreated}
              outputRoundingDecimals={outputRoundingDecimals}
              onOutputRoundingDecimalsChange={setOutputRoundingDecimals}
              buzzdetectDir={buzzdetectDir}
              onBuzzdetectDirChange={setBuzzdetectDir}
              syncRemoteUrl={syncRemoteUrl}
              onSyncRemoteUrlChange={setSyncRemoteUrl}
            />

          </>
        )}

        {activeTab === 'preferences' && (
          <>
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-gray-300 text-sm font-medium">Sync Settings</h3>
                <button
                  type="button"
                  onClick={openSyncGuideWindow}
                  className="text-gray-600 hover:text-gray-400 transition-colors"
                  data-tooltip={tooltips.setupSyncedProject}
                >
                  <HelpCircle size={14} />
                </button>
              </div>
              {syncRemoteUrl ? (
                <p className="text-gray-600 text-xs mb-4 font-mono truncate">{syncRemoteUrl}</p>
              ) : (
                <p className="text-gray-600 text-xs mb-4">
                  {createProjectModal.infoNoRepoConfigured}
                </p>
              )}
              <GitSyncUserFields
                syncToken={syncToken}
                onSyncTokenChange={setSyncToken}
                syncTokenStorage={syncTokenStorage}
                onSyncTokenStorageChange={setSyncTokenStorage}
                syncAuthorName={syncAuthorName}
                onSyncAuthorNameChange={setSyncAuthorName}
              />
            </div>

          </>
        )}
      </SettingsModalShell>
    </div>
  );
}
