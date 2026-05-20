import React, { useState, useRef, useEffect } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { Project } from '../types';
import { openDirectoryDialog, checkDirExists, listAnnotationFilesRecursive } from '../utils/tauriCommands';
import { getOrphanedAnnotations, deleteFiles, copyAnnotationFiles } from '../utils/projectCommands';
import GradientPicker from './GradientPicker';

type Step = 'form' | 'orphanConfirm' | 'annotationCopyConfirm' | 'conflictConfirm';

interface Props {
  project: Project;
  onSave: (updated: Project) => void;
  onClose: () => void;
}

export default function ProjectSettingsModal({ project, onSave, onClose }: Props) {
  const [name, setName] = useState(project.name);
  const nameRef = useRef<HTMLDivElement>(null);
  const [audioDir, setAudioDir] = useState(project.audioDirectory);
  const [annotationDir, setAnnotationDir] = useState(project.annotationDirectory);
  const outputFormat = 'txt' as const;
  const [outputRoundingDecimals, setOutputRoundingDecimals] = useState(project.outputRoundingDecimals ?? 4);
  const defaultColors = project.nameGradientColors ?? ['#e65161', '#f9c387'] as [string, string];
  const [gradientColors, setGradientColors] = useState<[string, string]>(defaultColors);

  // Set initial text content of the contentEditable name field on mount
  useEffect(() => {
    if (nameRef.current) nameRef.current.textContent = project.name;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [step, setStep] = useState<Step>('form');
  const [orphanedPaths, setOrphanedPaths] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  // Pending update — we build the final Project once all confirmations are done
  const pendingRef = React.useRef<Project | null>(null);

  const handleBrowseAudio = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setAudioDir(dir);
  };

  const handleBrowseAnnotation = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setAnnotationDir(dir);
  };

  // Called when user clicks Save on the main form
  const handleFormSubmit = async () => {
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!audioDir) { setError('Audio directory is required.'); return; }
    if (!annotationDir) { setError('Annotations directory is required.'); return; }

    setIsBusy(true);
    const [audioDirOk, annotationDirOk] = await Promise.all([
      checkDirExists(audioDir),
      checkDirExists(annotationDir),
    ]);
    setIsBusy(false);

    if (!audioDirOk) { setError('Audio directory does not exist.'); return; }
    if (!annotationDirOk) { setError('Annotations directory does not exist.'); return; }

    setError('');
    const updated: Project = {
      ...project,
      name: name.trim(),
      audioDirectory: audioDir,
      annotationDirectory: annotationDir,
      outputFormat,
      outputRoundingDecimals,
      nameGradientColors: gradientColors,
    };
    pendingRef.current = updated;

    const audioDirChanged = audioDir !== project.audioDirectory;
    const annotationDirChanged = annotationDir !== project.annotationDirectory;

    if (audioDirChanged) {
      setIsBusy(true);
      try {
        const orphans = await getOrphanedAnnotations(project.annotationDirectory, audioDir);
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

    onSave(updated);
  };

  // User chose to delete or retain orphaned annotations
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

    const annotationDirChanged = annotationDir !== project.annotationDirectory;
    if (annotationDirChanged) {
      setStep('annotationCopyConfirm');
    } else {
      const pending = pendingRef.current;
      if (!pending) return;
      onSave(pending);
    }
  };

  // User chose whether to copy annotations to new dir
  const handleCopyDecision = (shouldCopy: boolean) => {
    if (!shouldCopy) {
      const pending = pendingRef.current;
      if (!pending) return;
      onSave(pending);
      return;
    }
    setStep('conflictConfirm');
  };

  // User chose conflict resolution — perform the copy
  const handleConflictResolution = async (resolution: 'overwrite' | 'skip') => {
    const oldDir = project.annotationDirectory;
    const newDir = annotationDir;

    setIsBusy(true);
    try {
      // Build copies list: scan old dir for .txt files
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

        {/* Main form */}
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
                <label className="text-gray-400 text-sm block mb-1">Audio Directory</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={audioDir}
                    onChange={e => setAudioDir(e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleBrowseAudio}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </div>

              <div>
                <label className="text-gray-400 text-sm block mb-1">Annotations Directory</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={annotationDir}
                    onChange={e => setAnnotationDir(e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleBrowseAnnotation}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </div>

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

              {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}
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

        {/* Orphaned annotations confirmation */}
        {step === 'orphanConfirm' && (
          <>
            <h2 className="text-white text-lg font-semibold mb-4">Orphaned Annotations</h2>
            <p className="text-gray-300 text-sm mb-2">
              {orphanedPaths.length} annotation {orphanedPaths.length === 1 ? 'file has' : 'files have'} no
              corresponding audio in the new audio directory:
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

        {/* Copy annotations to new dir? */}
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

        {/* Conflict resolution */}
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
