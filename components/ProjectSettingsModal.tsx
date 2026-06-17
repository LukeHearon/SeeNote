import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Project, ProjectSettings } from '../types';
import { checkDirExists, listAnnotationFilesRecursive, getGitCredential, setGitCredential, deleteGitCredential } from '../utils/tauriCommands';
import { getOrphanedAnnotations, deleteFiles, copyAnnotationFiles, revealInFileManager } from '../utils/projectCommands';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';
import { makeProjectPath, resolveInputPath, trimProjectPrefix } from '../utils/projectPaths';
import { normalizeGitRemoteUrl } from '../utils/gitSync';
import SettingsModalShell from './SettingsModalShell';
import ProjectBaseFields from './ProjectBaseFields';

type Step = 'form' | 'orphanConfirm' | 'annotationCopyConfirm' | 'conflictConfirm';

interface Props {
  project: Project;
  onSave: (settings: ProjectSettings) => void;
  onClose: () => void;
}

export default function ProjectSettingsModal({ project, onSave, onClose }: Props) {
  const [name, setName] = useState(project.settings.name);
  const [mediaDir, setMediaDir] = useState(() => trimProjectPrefix(project.projectDir, project.mediaDirectoryAbs));
  const [annotationDir, setAnnotationDir] = useState(() => trimProjectPrefix(project.projectDir, project.annotationDirectoryAbs));
  const [buzzdetectDir, setBuzzdetectDir] = useState(() =>
    project.buzzdetectDirectoryAbs ? trimProjectPrefix(project.projectDir, project.buzzdetectDirectoryAbs) : '');
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
  const [syncAuthorName, setSyncAuthorName] = useState(project.settings.gitSync?.authorName ?? '');
  // Track the original URL so we can delete the old keyring entry if the user changes it.
  const initialRemoteUrlRef = React.useRef(project.settings.gitSync?.remoteUrl ?? '');

  React.useEffect(() => {
    const url = project.settings.gitSync?.remoteUrl;
    if (!url) return;
    getGitCredential(url).then(t => {
      if (t) setSyncTokenSavedLength(t.length);
    }).catch(err => {
      setError(`Could not read saved access token: ${String(err)}`);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedMediaDir = resolveInputPath(project.projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(project.projectDir, annotationDir);
  const resolvedBuzzdetectDir = resolveInputPath(project.projectDir, buzzdetectDir);

  const [step, setStep] = useState<Step>('form');
  const [orphanedPaths, setOrphanedPaths] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const pendingRef = React.useRef<ProjectSettings | null>(null);
  const copiesRef = React.useRef<{ src: string; dst: string }[] | null>(null);

  const commitSave = async (settings: ProjectSettings) => {
    onSave(settings);
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
    try {
      if (oldUrl && oldUrl !== newUrl) {
        await deleteGitCredential(oldUrl).catch(() => {});
      }
      if (newUrl && syncTokenDirty) {
        if (syncToken.trim()) {
          await setGitCredential(newUrl, syncToken.trim());
          setSyncTokenSavedLength(syncToken.trim().length);
          setSyncToken('');
          setSyncTokenDirty(false);
        } else {
          await deleteGitCredential(newUrl);
          setSyncTokenSavedLength(null);
        }
      } else if (!newUrl && oldUrl) {
        await deleteGitCredential(oldUrl);
        setSyncTokenSavedLength(null);
      }
    } catch (err) {
      setError(String(err));
      return;
    }

    const settings: ProjectSettings = {
      ...project.settings,
      name: name.trim(),
      mediaDirectory: makeProjectPath(project.projectDir, resolvedMediaDir),
      annotationDirectory: makeProjectPath(project.projectDir, resolvedAnnotationDir),
      buzzdetectDirectory: buzzdetectDir ? makeProjectPath(project.projectDir, resolvedBuzzdetectDir) : undefined,
      outputRoundingDecimals,
      nameGradientColors: gradientColors,
      gitSync: newUrl
        ? { remoteUrl: newUrl, authorName: syncAuthorName.trim() || undefined }
        : undefined,
    };
    pendingRef.current = settings;

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

    commitSave(settings);
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
    commitSave(pending);
  };

  const handleCopyDecision = async (shouldCopy: boolean) => {
    if (!shouldCopy) {
      const pending = pendingRef.current;
      if (!pending) return;
      commitSave(pending);
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
    commitSave(pending);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      {step === 'form' && (
        <SettingsModalShell
          title="Project Settings"
          onClose={onClose}
          footer={
            <>
              <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
                Cancel
              </button>
              <button
                onClick={handleFormSubmit}
                disabled={isBusy}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
              >
                {isBusy ? 'Checking…' : 'Save'}
              </button>
            </>
          }
        >
          <div>
            <label className="text-gray-400 text-sm block mb-1">Project Directory</label>
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
                title="Show in Finder"
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
            advancedDefaultOpen={!!project.buzzdetectDirectoryAbs}
            syncRemoteUrl={syncRemoteUrl}
            onSyncRemoteUrlChange={setSyncRemoteUrl}
            syncToken={syncToken}
            onSyncTokenChange={(v) => {
              setSyncTokenDirty(true);
              setSyncToken(v.replaceAll('•', ''));
            }}
            syncTokenDirty={syncTokenDirty}
            syncTokenSavedLength={syncTokenSavedLength}
            syncAuthorName={syncAuthorName}
            onSyncAuthorNameChange={setSyncAuthorName}
            syncDefaultOpen={!!project.settings.gitSync}
          />

          {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
        </SettingsModalShell>
      )}

      {step === 'orphanConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">Orphaned Annotations</h2>
          <p className="text-gray-300 text-sm mb-2">
            {orphanedPaths.length} annotation {orphanedPaths.length === 1 ? 'file has' : 'files have'} no
            corresponding media in the new media directory:
          </p>
          <ul className="bg-gray-800 rounded-lg p-3 mb-4 max-h-40 overflow-y-auto space-y-1">
            {orphanedPaths.map(p => (
              <li key={p} className="text-gray-400 text-xs font-mono truncate">{p}</li>
            ))}
          </ul>
          <p className="text-gray-300 text-sm mb-4">What would you like to do with these files?</p>
          {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleOrphanResolution('retain')}
              disabled={isBusy}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              Retain
            </button>
            <button
              onClick={() => handleOrphanResolution('delete')}
              disabled={isBusy}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? 'Deleting…' : 'Delete Orphaned'}
            </button>
          </div>
        </div>
      )}

      {step === 'annotationCopyConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">Move Annotations</h2>
          <p className="text-gray-300 text-sm mb-6">
            The annotations directory has changed. Would you like to copy your existing
            annotation files to the new directory?
          </p>
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleCopyDecision(false)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
            >
              Don't Copy
            </button>
            <button
              onClick={() => handleCopyDecision(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors"
            >
              Copy Annotations
            </button>
          </div>
        </div>
      )}

      {step === 'conflictConfirm' && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
          <h2 className="text-white text-lg font-semibold mb-4">Handle Conflicts</h2>
          <p className="text-gray-300 text-sm mb-6">
            If annotation files already exist in the new directory, how should conflicts be resolved?
          </p>
          {error && <p className="text-red-400 text-sm mb-3 whitespace-pre-wrap">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => handleConflictResolution('skip')}
              disabled={isBusy}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? 'Copying…' : 'Skip Existing'}
            </button>
            <button
              onClick={() => handleConflictResolution('overwrite')}
              disabled={isBusy}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isBusy ? 'Copying…' : 'Overwrite'}
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
