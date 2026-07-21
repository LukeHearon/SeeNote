import React, { useState } from 'react';
import { ExternalLink, HelpCircle } from 'lucide-react';
import { projectSettingsModal } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { GitSyncUserConfig, Project, ProjectSettings, ProjectPreferences } from '../types';
import { checkDirExists, listAnnotationFilesRecursive, getGitCredential, deleteGitCredential, openSyncGuideWindow } from '../utils/tauriCommands';
import { getOrphanedAnnotations, deleteFiles, copyAnnotationFiles, revealInFileManager } from '../utils/projectCommands';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_VIDEO_PANE_AUTO_COLLAPSE, DEFAULT_AUTO_PULL_REMOTE_CHANGES } from '../constants';
import { makeProjectPath, resolveInputPath, trimProjectPrefix } from '../utils/projectPaths';
import { normalizeGitRemoteUrl, readSyncToken, applySyncToken, type TokenStorage } from '../utils/gitSync';
import SettingsModalShell from './SettingsModalShell';
import ProjectBaseFields from './ProjectBaseFields';
import GitSyncUserFields from './GitSyncUserFields';

type Step = 'form' | 'orphanConfirm' | 'annotationCopyConfirm' | 'conflictConfirm';
type SettingsTab = 'settings' | 'preferences';

interface Props {
  project: Project;
  onSave: (settings: ProjectSettings, preferences: ProjectPreferences) => void;
  onClose: () => void;
}

export default function ProjectSettingsModal({ project, onSave, onClose }: Props) {
  const [name, setName] = useState(project.settings.projectName);
  const [mediaDir, setMediaDir] = useState(() => trimProjectPrefix(project.projectDir, project.mediaDirectoryAbs));
  const [annotationDir, setAnnotationDir] = useState(() => trimProjectPrefix(project.projectDir, project.annotationDirectoryAbs));
  const [buzzdetectDir, setBuzzdetectDir] = useState(() =>
    project.buzzdetectDirectoryAbs ? trimProjectPrefix(project.projectDir, project.buzzdetectDirectoryAbs) : '');
  const [buzzdetectFrameLength, setBuzzdetectFrameLength] = useState<number | null>(
    project.settings.buzzdetectFrameLength ?? null,
  );
  const [outputRoundingDecimals, setOutputRoundingDecimals] = useState(
    project.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS,
  );
  const [gradientColors, setGradientColors] = useState<[string, string]>(
    project.settings.nameGradientColors ?? ['#e65161', '#f9c387'],
  );
  const [syncRemoteUrl, setSyncRemoteUrl] = useState(project.settings.gitSync?.remoteUrl ?? '');
  const [syncToken, setSyncToken] = useState('');
  const [syncTokenDirty, setSyncTokenDirty] = useState(false);
  const [syncTokenSavedLength, setSyncTokenSavedLength] = useState<number | null>(null);
  const [syncTokenStorage, setSyncTokenStorage] = useState<TokenStorage>(
    project.preferences.gitSyncUser?.tokenStorage ?? 'keychain',
  );
  const [syncAuthorName, setSyncAuthorName] = useState(project.preferences.gitSyncUser?.authorName ?? '');
  const [videoPaneAutoCollapse, setVideoPaneAutoCollapse] = useState(
    project.preferences.videoPaneAutoCollapse ?? DEFAULT_VIDEO_PANE_AUTO_COLLAPSE,
  );
  const [autoPullRemoteChanges, setAutoPullRemoteChanges] = useState(
    project.preferences.autoPullRemoteChanges ?? DEFAULT_AUTO_PULL_REMOTE_CHANGES,
  );
  // Track the original URL so we can delete the old keyring entry if the user changes it.
  const initialRemoteUrlRef = React.useRef(project.settings.gitSync?.remoteUrl ?? '');

  React.useEffect(() => {
    const cfg = project.settings.gitSync;
    const userCfg = project.preferences.gitSyncUser ?? {};
    if (!cfg?.remoteUrl) return;
    readSyncToken(cfg.remoteUrl, userCfg).then(t => {
      if (t) setSyncTokenSavedLength(t.length);
    }).catch(err => {
      setError(`Could not read saved access token: ${String(err)}`);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedMediaDir = resolveInputPath(project.projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(project.projectDir, annotationDir);
  const resolvedBuzzdetectDir = resolveInputPath(project.projectDir, buzzdetectDir);

  const [activeTab, setActiveTab] = useState<SettingsTab>('settings');
  const [focusToken, setFocusToken] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [orphanedPaths, setOrphanedPaths] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const pendingRef = React.useRef<{ settings: ProjectSettings; preferences: ProjectPreferences } | null>(null);
  const copiesRef = React.useRef<{ src: string; dst: string }[] | null>(null);

  const commitSave = async (settings: ProjectSettings, preferences: ProjectPreferences) => {
    onSave(settings, preferences);
  };

  const handleFormSubmit = async () => {
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!mediaDir) { setError('Media directory is required.'); return; }
    if (!annotationDir) { setError('Annotations directory is required.'); return; }

    setIsBusy(true);
    const mediaDirOk = await checkDirExists(resolvedMediaDir);
    setIsBusy(false);

    if (!mediaDirOk) { setError('Media directory does not exist.'); return; }

    setError('');

    const oldUrl = initialRemoteUrlRef.current;
    const newUrl = normalizeGitRemoteUrl(syncRemoteUrl);
    const initialStorage: TokenStorage = project.preferences.gitSyncUser?.tokenStorage ?? 'keychain';
    const existingPlaintext = project.preferences.gitSyncUser?.tokenPlaintext;
    // Token-storage fields to persist in gitSyncUser preferences. Default to no token for the
    // current mode; the branches below fill in the real value.
    let tokenFields: Pick<GitSyncUserConfig, 'tokenStorage' | 'tokenPlaintext'> = { tokenStorage: syncTokenStorage };
    try {
      if (oldUrl && oldUrl !== newUrl) {
        await deleteGitCredential(oldUrl).catch(() => {});
      }
      if (newUrl) {
        if (syncTokenDirty) {
          // User typed (or cleared) the token: store it in the chosen mode.
          const t = syncToken.trim() || null;
          tokenFields = await applySyncToken(newUrl, syncTokenStorage, t);
          setSyncTokenSavedLength(t ? t.length : null);
          setSyncToken('');
          setSyncTokenDirty(false);
        } else if (syncTokenStorage !== initialStorage) {
          // Storage mode switched without retyping: migrate the existing token
          // across stores. Reading from the keychain prompts once (expected).
          const current = initialStorage === 'plaintext'
            ? (existingPlaintext ?? null)
            : await getGitCredential(newUrl);
          tokenFields = await applySyncToken(newUrl, syncTokenStorage, current);
          setSyncTokenSavedLength(current ? current.length : null);
        } else {
          // Mode and token unchanged: keep as-is, no IPC (no keychain prompt).
          tokenFields = syncTokenStorage === 'plaintext'
            ? { tokenStorage: 'plaintext', tokenPlaintext: existingPlaintext }
            : { tokenStorage: 'keychain' };
        }
      } else if (oldUrl) {
        await deleteGitCredential(oldUrl).catch(() => {});
        setSyncTokenSavedLength(null);
      }
    } catch (err) {
      setError(String(err));
      return;
    }

    const settings: ProjectSettings = {
      ...project.settings,
      projectName: name.trim(),
      mediaDirectory: makeProjectPath(project.projectDir, resolvedMediaDir),
      annotationDirectory: makeProjectPath(project.projectDir, resolvedAnnotationDir),
      buzzdetectDirectory: buzzdetectDir ? makeProjectPath(project.projectDir, resolvedBuzzdetectDir) : undefined,
      buzzdetectFrameLength: buzzdetectFrameLength ?? undefined,
      outputRoundingDecimals,
      nameGradientColors: gradientColors,
      gitSync: newUrl ? { remoteUrl: newUrl } : undefined,
    };
    const preferences: ProjectPreferences = {
      ...project.preferences,
      gitSyncUser: newUrl
        ? { authorName: syncAuthorName.trim() || undefined, ...tokenFields }
        : undefined,
      videoPaneAutoCollapse,
      autoPullRemoteChanges,
    };
    pendingRef.current = { settings, preferences };

    const mediaDirChanged = resolvedMediaDir !== project.mediaDirectoryAbs;
    const annotationDirChanged = resolvedAnnotationDir !== project.annotationDirectoryAbs;

    if (mediaDirChanged) {
      setIsBusy(true);
      try {
        const orphans = await getOrphanedAnnotations(project.annotationDirectoryAbs, resolvedMediaDir);
        setIsBusy(false);
        if (orphans.length > 0) {
          setOrphanedPaths(orphans);
          setStep('orphanConfirm');
          return;
        }
      } catch (err) {
        setIsBusy(false);
        setError(String(err));
        return;
      }
    }

    if (annotationDirChanged) {
      setIsBusy(true);
      let sourceFiles: string[] = [];
      try {
        sourceFiles = await listAnnotationFilesRecursive(project.annotationDirectoryAbs, '.txt');
      } catch { /* old dir doesn't exist */ }
      setIsBusy(false);
      if (sourceFiles.length > 0) {
        setStep('annotationCopyConfirm');
        return;
      }
    }

    commitSave(settings, preferences);
  };

  const handleOrphanResolution = async (resolution: 'delete' | 'retain') => {
    if (resolution === 'delete') {
      setIsBusy(true);
      try {
        await deleteFiles(orphanedPaths);
      } catch (err) {
        setError(String(err));
        setIsBusy(false);
        return;
      }
      setIsBusy(false);
    }

    const annotationDirChanged = resolvedAnnotationDir !== project.annotationDirectoryAbs;
    if (annotationDirChanged) {
      setIsBusy(true);
      let sourceFiles: string[] = [];
      try {
        sourceFiles = await listAnnotationFilesRecursive(project.annotationDirectoryAbs, '.txt');
      } catch { /* old dir doesn't exist */ }
      setIsBusy(false);
      if (sourceFiles.length > 0) {
        setStep('annotationCopyConfirm');
        return;
      }
    }

    const pending = pendingRef.current;
    if (!pending) return;
    commitSave(pending.settings, pending.preferences);
  };

  const handleCopyDecision = async (shouldCopy: boolean) => {
    if (!shouldCopy) {
      const pending = pendingRef.current;
      if (!pending) return;
      commitSave(pending.settings, pending.preferences);
      return;
    }

    setIsBusy(true);
    let copies: { src: string; dst: string }[];
    try {
      copies = await buildCopiesList(project.annotationDirectoryAbs, resolvedAnnotationDir);
    } catch (err) {
      setError(String(err));
      setIsBusy(false);
      return;
    }
    copiesRef.current = copies;

    let existingDsts = new Set<string>();
    try {
      const newDirFiles = await listAnnotationFilesRecursive(resolvedAnnotationDir, '.txt');
      existingDsts = new Set(newDirFiles);
    } catch { /* new dir doesn't exist yet — no conflicts */ }
    setIsBusy(false);

    if (copies.some(c => existingDsts.has(c.dst))) {
      setStep('conflictConfirm');
    } else {
      await handleConflictResolution('skip');
    }
  };

  const handleConflictResolution = async (resolution: 'overwrite' | 'skip') => {
    setIsBusy(true);
    try {
      const copies = copiesRef.current ?? await buildCopiesList(project.annotationDirectoryAbs, resolvedAnnotationDir);
      const result = await copyAnnotationFiles(copies, resolution);
      if (result.errors.length > 0) {
        setError(`Copy completed with errors:\n${result.errors.join('\n')}`);
        setIsBusy(false);
        return;
      }
    } catch (err) {
      setError(String(err));
      setIsBusy(false);
      return;
    }

    setIsBusy(false);
    const pending = pendingRef.current;
    if (!pending) return;
    commitSave(pending.settings, pending.preferences);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      {step === 'form' && (
        <SettingsModalShell
          title={projectSettingsModal.title}
          onClose={onClose}
          tabs={[
            { label: projectSettingsModal.tabSettings, active: activeTab === 'settings', onClick: () => setActiveTab('settings') },
            { label: projectSettingsModal.tabPreferences, active: activeTab === 'preferences', onClick: () => setActiveTab('preferences') },
          ]}
          footer={
            <>
              <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
                {projectSettingsModal.cancelButton}
              </button>
              <button
                onClick={handleFormSubmit}
                disabled={isBusy}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
              >
                {isBusy ? projectSettingsModal.savingButton : projectSettingsModal.saveButton}
              </button>
            </>
          }
        >
          {activeTab === 'settings' && (
            <>
              <div>
                <label className="text-gray-400 text-sm block mb-1">{projectSettingsModal.projectDirLabel}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={project.projectDir}
                    disabled
                    className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-400 text-sm cursor-not-allowed"
                  />
                  <button
                    onClick={() => revealInFileManager(project.projectDir)}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
                    title={projectSettingsModal.showInFinderTitle}
                  >
                    <ExternalLink size={16} />
                  </button>
                </div>
              </div>

              <ProjectBaseFields
                projectDir={project.projectDir}
                name={name}
                onNameInput={setName}
                gradientColors={gradientColors}
                onGradientChange={setGradientColors}
                mediaDir={mediaDir}
                onMediaDirChange={setMediaDir}
                mediaDirNotExistMessage="Directory does not exist."
                annotationDir={annotationDir}
                onAnnotationDirChange={setAnnotationDir}
                annotationDirNotExistMessage="Directory does not exist yet; it will be created when the first annotation is saved."
                outputRoundingDecimals={outputRoundingDecimals}
                onOutputRoundingDecimalsChange={setOutputRoundingDecimals}
                buzzdetectDir={buzzdetectDir}
                onBuzzdetectDirChange={setBuzzdetectDir}
                buzzdetectFrameLength={buzzdetectFrameLength}
                onBuzzdetectFrameLengthChange={setBuzzdetectFrameLength}
                advancedDefaultOpen={!!project.buzzdetectDirectoryAbs}
                syncRemoteUrl={syncRemoteUrl}
                onSyncRemoteUrlChange={setSyncRemoteUrl}
                onAddAccessToken={() => { setActiveTab('preferences'); setFocusToken(true); }}
              />

              {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
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
                <GitSyncUserFields
                  syncToken={syncToken}
                  onSyncTokenChange={v => { setSyncTokenDirty(true); setSyncToken(v.replaceAll('•', '')); }}
                  syncTokenDirty={syncTokenDirty}
                  syncTokenSavedLength={syncTokenSavedLength}
                  syncTokenStorage={syncTokenStorage}
                  onSyncTokenStorageChange={setSyncTokenStorage}
                  syncAuthorName={syncAuthorName}
                  onSyncAuthorNameChange={setSyncAuthorName}
                  autoFocusToken={focusToken}
                />
                <label className="flex items-start gap-2 cursor-pointer select-none mt-3">
                  <input
                    type="checkbox"
                    checked={autoPullRemoteChanges}
                    onChange={(e) => setAutoPullRemoteChanges(e.target.checked)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span>
                    <span className="block text-sm text-gray-200">{projectSettingsModal.autoPullLabel}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{projectSettingsModal.autoPullHint}</span>
                  </span>
                </label>
              </div>

              <div>
                <h3 className="text-gray-300 text-sm font-medium mb-3">{projectSettingsModal.videoPaneHeader}</h3>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={videoPaneAutoCollapse}
                    onChange={(e) => setVideoPaneAutoCollapse(e.target.checked)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span>
                    <span className="block text-sm text-gray-200">{projectSettingsModal.videoAutoCollapseLabel}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{projectSettingsModal.videoAutoCollapseHint}</span>
                  </span>
                </label>
              </div>

              {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
            </>
          )}
        </SettingsModalShell>
      )}

      {step === 'orphanConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">{projectSettingsModal.orphanedTitle}</h2>
          <p className="text-gray-300 text-sm mb-2">
            {orphanedPaths.length} annotation {orphanedPaths.length === 1 ? 'file has' : 'files have'} {projectSettingsModal.orphanedNoMedia}
          </p>
          <ul className="bg-gray-800 rounded-lg p-3 mb-4 max-h-40 overflow-y-auto space-y-1">
            {orphanedPaths.map(p => (
              <li key={p} className="text-gray-400 text-xs font-mono truncate">{p}</li>
            ))}
          </ul>
          <p className="text-gray-300 text-sm mb-4">{projectSettingsModal.orphanedWhatToDo}</p>
          {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleOrphanResolution('retain')}
              disabled={isBusy}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {projectSettingsModal.retainButton}
            </button>
            <button
              onClick={() => handleOrphanResolution('delete')}
              disabled={isBusy}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? projectSettingsModal.deletingButton : projectSettingsModal.deleteOrphanedButton}
            </button>
          </div>
        </div>
      )}

      {step === 'annotationCopyConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">{projectSettingsModal.moveAnnotationsTitle}</h2>
          <p className="text-gray-300 text-sm mb-6">
            {projectSettingsModal.moveAnnotationsMessage}
          </p>
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleCopyDecision(false)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
            >
              {projectSettingsModal.dontCopyButton}
            </button>
            <button
              onClick={() => handleCopyDecision(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors"
            >
              {projectSettingsModal.copyAnnotationsButton}
            </button>
          </div>
        </div>
      )}

      {step === 'conflictConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">{projectSettingsModal.handleConflictsTitle}</h2>
          <p className="text-gray-300 text-sm mb-6">
            {projectSettingsModal.handleConflictsMessage}
          </p>
          {error && <p className="text-red-400 text-sm mb-3 whitespace-pre-wrap">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleConflictResolution('skip')}
              disabled={isBusy}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? projectSettingsModal.copyingButton : projectSettingsModal.skipExistingButton}
            </button>
            <button
              onClick={() => handleConflictResolution('overwrite')}
              disabled={isBusy}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? projectSettingsModal.copyingButton : projectSettingsModal.overwriteButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

async function buildCopiesList(
  oldDir: string,
  newDir: string,
): Promise<{ src: string; dst: string }[]> {
  const files = await listAnnotationFilesRecursive(oldDir, '.txt');
  return files.map(src => {
    const rel = src.startsWith(oldDir) ? src.slice(oldDir.length) : src;
    return { src, dst: newDir + rel };
  });
}
