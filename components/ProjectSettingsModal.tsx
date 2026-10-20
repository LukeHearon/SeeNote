import React, { useState } from 'react';
import { ExternalLink, HelpCircle } from 'lucide-react';
import { projectSettingsModal, projectBaseFields } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { GitSyncUserConfig, Project, ProjectSettings, ProjectPreferences } from '../types';
import { checkDirExists, listAnnotationFilesRecursive, getGitCredential, deleteGitCredential, openSyncGuideWindow } from '../utils/tauriCommands';
import { copyAnnotationFiles, revealInFileManager } from '../utils/projectCommands';
import { DEFAULT_AUTO_PULL_REMOTE_CHANGES } from '../constants';
import { resolveInputPath } from '../utils/projectPaths';
import { normalizeGitRemoteUrl, readSyncToken, applySyncToken, type TokenStorage } from '../utils/gitSync';
import SettingsModalShell from './SettingsModalShell';
import ProjectBaseFields from './ProjectBaseFields';
import GitSyncUserFields from './GitSyncUserFields';
import ApplicationSettingsFields from './ApplicationSettingsFields';
import SingleFileSettingsFields from './SingleFileSettingsFields';
import ModalBackdrop from './ModalBackdrop';
import { useProjectForm } from '../hooks/useProjectForm';
import { projectFormFromSettings, missingProjectField, settingsFromProjectForm } from '../utils/projectForm';

type Step = 'form' | 'annotationCopyConfirm' | 'conflictConfirm';
export type SettingsTab = 'application' | 'singleFile' | 'settings' | 'preferences';

interface Props {
  /** Omit to open the modal in application-settings-only mode (from the
   *  launch screen or single-file mode) — the Project Settings and User
   *  Preferences tabs only make sense once a project is open, and the Single
   *  File tab only without one. */
  project?: Project;
  onSave?: (settings: ProjectSettings, preferences: ProjectPreferences) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}

export default function ProjectSettingsModal({ project, onSave, onClose, initialTab }: Props) {
  const { values: form, set: setForm } = useProjectForm(() => projectFormFromSettings(project?.settings));
  const [syncToken, setSyncToken] = useState('');
  const [syncTokenDirty, setSyncTokenDirty] = useState(false);
  const [syncTokenSavedLength, setSyncTokenSavedLength] = useState<number | null>(null);
  const [syncTokenStorage, setSyncTokenStorage] = useState<TokenStorage>(
    project?.preferences.gitSyncUser?.tokenStorage ?? 'keychain',
  );
  const [autoPullRemoteChanges, setAutoPullRemoteChanges] = useState(
    project?.preferences.autoPullRemoteChanges ?? DEFAULT_AUTO_PULL_REMOTE_CHANGES,
  );
  // Track the original URL so we can delete the old keyring entry if the user changes it.
  const initialRemoteUrlRef = React.useRef(project?.settings.gitSync?.remoteUrl ?? '');

  React.useEffect(() => {
    if (!project) return;
    const cfg = project.settings.gitSync;
    const userCfg = project.preferences.gitSyncUser ?? {};
    if (!cfg?.remoteUrl) return;
    readSyncToken(cfg.remoteUrl, userCfg).then(t => {
      if (t) setSyncTokenSavedLength(t.length);
    }).catch(err => {
      setError(`Could not read saved access token: ${String(err)}`);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedMediaDir = project ? resolveInputPath(project.projectDir, form.mediaDir) : '';
  const resolvedAnnotationDir = project ? resolveInputPath(project.projectDir, form.annotationDir) : '';

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? (project ? 'settings' : 'application'));
  const [focusToken, setFocusToken] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const pendingRef = React.useRef<{ settings: ProjectSettings; preferences: ProjectPreferences } | null>(null);
  const copiesRef = React.useRef<{ src: string; dst: string }[] | null>(null);

  const commitSave = async (settings: ProjectSettings, preferences: ProjectPreferences) => {
    onSave?.(settings, preferences);
  };

  const handleFormSubmit = async () => {
    if (!project) { onClose(); return; }
    const missing = missingProjectField(form);
    if (missing) {
      setError({
        name: projectSettingsModal.errorNameRequired,
        media: projectSettingsModal.errorMediaRequired,
        annotations: projectSettingsModal.errorAnnotationsRequired,
      }[missing]);
      return;
    }

    setIsBusy(true);
    const mediaDirOk = await checkDirExists(resolvedMediaDir);
    setIsBusy(false);

    if (!mediaDirOk) { setError(projectSettingsModal.errorMediaMissing); return; }

    setError('');

    const oldUrl = initialRemoteUrlRef.current;
    const newUrl = normalizeGitRemoteUrl(form.syncRemoteUrl);
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

    const settings = settingsFromProjectForm(form, project.projectDir, newUrl, project.settings);
    const preferences: ProjectPreferences = {
      ...project.preferences,
      gitSyncUser: newUrl
        // The legacy per-project name is kept as the app-wide setting's fallback.
        ? { authorName: project.preferences.gitSyncUser?.authorName, ...tokenFields }
        : undefined,
      autoPullRemoteChanges,
    };
    pendingRef.current = { settings, preferences };

    // Pointing the project at a different media directory used to offer to
    // delete annotation files with no matching media. It no longer does, and
    // nothing else may either: annotations are the irreplaceable half of this
    // project, and "no media here" is not evidence the labels are unwanted —
    // the recordings may simply have been offloaded to free disk space.
    // Orphans are harmless; they sit in the annotation directory until the
    // media comes back.
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

    commitSave(settings, preferences);
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
    <ModalBackdrop onDismiss={step === 'form' ? onClose : undefined}>
      {step === 'form' && (
        <SettingsModalShell
          title={project ? projectSettingsModal.title : projectSettingsModal.titleApplicationOnly}
          onClose={onClose}
          tabs={project ? [
            { label: projectSettingsModal.tabApplication, active: activeTab === 'application', onClick: () => setActiveTab('application') },
            { label: projectSettingsModal.tabSettings, active: activeTab === 'settings', onClick: () => setActiveTab('settings') },
            { label: projectSettingsModal.tabPreferences, active: activeTab === 'preferences', onClick: () => setActiveTab('preferences') },
          ] : [
            { label: projectSettingsModal.tabApplication, active: activeTab === 'application', onClick: () => setActiveTab('application') },
            { label: projectSettingsModal.tabSingleFile, active: activeTab === 'singleFile', onClick: () => setActiveTab('singleFile') },
          ]}
          footer={
            project ? (
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
            ) : (
              <button onClick={onClose} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors">
                {projectSettingsModal.closeButton}
              </button>
            )
          }
        >
          {activeTab === 'application' && (
            <ApplicationSettingsFields
              legacyDateTimeFormat={project?.preferences.dateTimeFormat}
              legacyAnnotatorName={project?.preferences.gitSyncUser?.authorName}
            />
          )}

          {!project && activeTab === 'singleFile' && <SingleFileSettingsFields />}

          {project && activeTab === 'settings' && (
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
                values={form}
                onChange={setForm}
                mediaDirNotExistMessage={projectSettingsModal.mediaDirMissing}
                annotationDirNotExistMessage={projectSettingsModal.annotationDirMissing}
                advancedDefaultOpen={!!project.buzzdetectDirectoryAbs}
                onAddAccessToken={() => { setActiveTab('preferences'); setFocusToken(true); }}
              />

              {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
            </>
          )}

          {project && activeTab === 'preferences' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-gray-300 text-sm font-medium">{projectBaseFields.syncSettingsHeading}</h3>
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

              {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
            </>
          )}
        </SettingsModalShell>
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
    </ModalBackdrop>
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
