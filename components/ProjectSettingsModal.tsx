import React, { useState, useRef, useEffect } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { Project, ProjectSettings } from '../types';
import { checkDirExists, listAnnotationFilesRecursive } from '../utils/tauriCommands';
import { getOrphanedAnnotations, deleteFiles, copyAnnotationFiles, revealInFileManager } from '../utils/projectCommands';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS } from '../constants';
import { makeProjectPath, resolveInputPath, trimProjectPrefix } from '../utils/projectPaths';
import GradientPicker from './GradientPicker';
import DirectoryField from './DirectoryField';
import CollapsibleSection from './CollapsibleSection';

type Step = 'form' | 'orphanConfirm' | 'annotationCopyConfirm' | 'conflictConfirm';

interface Props {
  project: Project;
  onSave: (settings: ProjectSettings) => void;
  onClose: () => void;
}

export default function ProjectSettingsModal({ project, onSave, onClose }: Props) {
  const [name, setName] = useState(project.settings.name);
  const nameRef = useRef<HTMLDivElement>(null);
  const [mediaDir, setMediaDir] = useState(() => trimProjectPrefix(project.projectDir, project.mediaDirectoryAbs));
  const [annotationDir, setAnnotationDir] = useState(() => trimProjectPrefix(project.projectDir, project.annotationDirectoryAbs));
  const [buzzdetectDir, setBuzzdetectDir] = useState(() =>
    project.buzzdetectDirectoryAbs ? trimProjectPrefix(project.projectDir, project.buzzdetectDirectoryAbs) : '');
  const [outputRoundingDecimals, setOutputRoundingDecimals] = useState(
    project.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS,
  );
  const defaultColors = project.settings.nameGradientColors ?? ['#e65161', '#f9c387'] as [string, string];
  const [gradientColors, setGradientColors] = useState<[string, string]>(defaultColors);

  // Resolved absolute paths — used for filesystem operations and settings serialisation.
  const resolvedMediaDir = resolveInputPath(project.projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(project.projectDir, annotationDir);
  const resolvedBuzzdetectDir = resolveInputPath(project.projectDir, buzzdetectDir);

  useEffect(() => {
    if (nameRef.current) nameRef.current.textContent = project.settings.name;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [step, setStep] = useState<Step>('form');
  const [orphanedPaths, setOrphanedPaths] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const pendingRef = React.useRef<ProjectSettings | null>(null);

  const handleFormSubmit = async () => {
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!mediaDir) { setError('Media directory is required.'); return; }
    if (!annotationDir) { setError('Annotations directory is required.'); return; }

    setIsBusy(true);
    const mediaDirOk = await checkDirExists(resolvedMediaDir);
    setIsBusy(false);

    if (!mediaDirOk) { setError('Media directory does not exist.'); return; }

    setError('');
    const settings: ProjectSettings = {
      ...project.settings,
      name: name.trim(),
      mediaDirectory: makeProjectPath(project.projectDir, resolvedMediaDir),
      annotationDirectory: makeProjectPath(project.projectDir, resolvedAnnotationDir),
      buzzdetectDirectory: buzzdetectDir ? makeProjectPath(project.projectDir, resolvedBuzzdetectDir) : undefined,
      outputRoundingDecimals,
      nameGradientColors: gradientColors,
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
      setStep('annotationCopyConfirm');
      return;
    }

    onSave(settings);
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
      setStep('annotationCopyConfirm');
    } else {
      const pending = pendingRef.current;
      if (!pending) return;
      onSave(pending);
    }
  };

  const handleCopyDecision = (shouldCopy: boolean) => {
    if (!shouldCopy) {
      const pending = pendingRef.current;
      if (!pending) return;
      onSave(pending);
      return;
    }
    setStep('conflictConfirm');
  };

  const handleConflictResolution = async (resolution: 'overwrite' | 'skip') => {
    const oldDir = project.annotationDirectoryAbs;
    const newDir = resolvedAnnotationDir;

    setIsBusy(true);
    try {
      const copies = await buildCopiesList(oldDir, newDir);
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
    onSave(pending);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">

        {step === 'form' && (
          <>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-white text-lg font-semibold">Project Settings</h2>
              <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-gray-400 text-sm block mb-1">Project Name</label>
                <div className="border-b border-gray-600 focus-within:border-blue-500 pb-1">
                  <div
                    ref={nameRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={e => setName((e.target as HTMLDivElement).textContent || '')}
                    onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                    onPaste={e => {
                      e.preventDefault();
                      const text = e.clipboardData.getData('text/plain');
                      const sel = window.getSelection();
                      if (!sel || !sel.rangeCount) return;
                      const range = sel.getRangeAt(0);
                      range.deleteContents();
                      range.insertNode(document.createTextNode(text));
                      range.collapse(false);
                      sel.removeAllRanges();
                      sel.addRange(range);
                    }}
                    className="text-xl font-bold bg-clip-text text-transparent outline-none cursor-text"
                    style={{
                      backgroundImage: `linear-gradient(to right, ${gradientColors[0]}, ${gradientColors[1]})`,
                      display: 'inline-block',
                      minWidth: '2ch',
                    }}
                  />
                </div>
                <div className="mt-3">
                  <GradientPicker value={gradientColors} onChange={setGradientColors} />
                </div>
              </div>

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

              <DirectoryField
                label="Media"
                projectDir={project.projectDir}
                value={mediaDir}
                onChange={setMediaDir}
                notExistMessage="Directory does not exist."
              />

              <DirectoryField
                label="Annotations"
                projectDir={project.projectDir}
                value={annotationDir}
                onChange={setAnnotationDir}
                notExistMessage="Directory does not exist yet; it will be created when the first annotation is saved."
              />

              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-gray-400 text-sm block">Output Decimal Places</label>
                    <p className="text-gray-600 text-xs">for start/end timestamps</p>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max="9"
                    step="1"
                    value={outputRoundingDecimals}
                    onChange={e => {
                      const v = parseInt(e.target.value);
                      if (!isNaN(v)) setOutputRoundingDecimals(Math.min(9, Math.max(0, v)));
                    }}
                    className="w-16 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <CollapsibleSection title="Advanced" defaultOpen={!!project.buzzdetectDirectoryAbs}>
                <DirectoryField
                  label="buzzdetect"
                  projectDir={project.projectDir}
                  value={buzzdetectDir}
                  onChange={setBuzzdetectDir}
                  placeholder="(optional) directory of {ident}_buzzdetect.csv"
                  helperText="Activations plotted below the spectrogram, located per track by ident."
                  notExistMessage="Directory does not exist."
                />
              </CollapsibleSection>

              {error && (
                <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>
              )}
            </div>

            <div className="flex gap-3 mt-6 justify-end">
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
            </div>
          </>
        )}

        {step === 'orphanConfirm' && (
          <>
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
          </>
        )}

        {step === 'annotationCopyConfirm' && (
          <>
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
          </>
        )}

        {step === 'conflictConfirm' && (
          <>
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
          </>
        )}
      </div>
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
    const dst = newDir + rel;
    return { src, dst };
  });
}
