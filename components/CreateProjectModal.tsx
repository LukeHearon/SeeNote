import React, { useState, useRef, useEffect } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { Project, ProjectSettings } from '../types';
import { openDirectoryDialog, checkDirExists, createDirAll } from '../utils/tauriCommands';
import { readProjectSettings } from '../utils/projectCommands';
import { DEFAULT_ANNOTATION_TOOLS, randomMagmaGradient } from '../constants';
import { makeProjectPath, isInsideProjectDir, isAbsolutePath, resolveInputPath, trimProjectPrefix } from '../utils/projectPaths';
import GradientPicker from './GradientPicker';

interface Props {
  onCreated: (project: Project) => void;
  onClose: () => void;
  createProject: (args: { projectDir: string; settings: ProjectSettings }) => Promise<Project>;
}


const PORTABILITY_WARNING =
  'This path is outside the project directory; the project will not be portable to other machines unless you also move it.';

export default function CreateProjectModal({ onCreated, onClose, createProject }: Props) {
  const [projectDir, setProjectDir] = useState('');
  const [name, setName] = useState('');
  const [mediaDir, setMediaDir] = useState('');
  const [annotationDir, setAnnotationDir] = useState('');
  const [gradientColors, setGradientColors] = useState<[string, string]>(() => randomMagmaGradient());
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [mediaDirExists, setMediaDirExists] = useState<boolean | null>(null);
  const [annotationDirExists, setAnnotationDirExists] = useState<boolean | null>(null);
  const [existingProjectName, setExistingProjectName] = useState<string | null>(null);

  const nameTouchedRef = useRef(false);
  const mediaTouchedRef = useRef(false);
  const annotationTouchedRef = useRef(false);

  // Resolved absolute paths — used for all filesystem operations and settings serialisation.
  const resolvedMediaDir = resolveInputPath(projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(projectDir, annotationDir);

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

  useEffect(() => {
    let cancelled = false;
    if (!resolvedMediaDir) { setMediaDirExists(null); return; }
    const t = setTimeout(() => {
      checkDirExists(resolvedMediaDir).then(exists => { if (!cancelled) setMediaDirExists(exists); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [resolvedMediaDir]);

  useEffect(() => {
    let cancelled = false;
    if (!resolvedAnnotationDir) { setAnnotationDirExists(null); return; }
    const t = setTimeout(() => {
      checkDirExists(resolvedAnnotationDir).then(exists => { if (!cancelled) setAnnotationDirExists(exists); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [resolvedAnnotationDir]);

  const checkExistingProject = async (dir: string) => {
    if (!dir) { setExistingProjectName(null); return; }
    try {
      const existing = await readProjectSettings(dir);
      setExistingProjectName(existing.name);
    } catch {
      setExistingProjectName(null);
    }
  };

  const handleBrowseProject = async () => {
    const dir = await openDirectoryDialog();
    if (dir) { setProjectDir(dir); checkExistingProject(dir); }
  };

  const handleBrowseMedia = async () => {
    const dir = await openDirectoryDialog();
    if (dir) { mediaTouchedRef.current = true; setMediaDir(trimProjectPrefix(projectDir, dir)); }
  };

  const handleBrowseAnnotation = async () => {
    const dir = await openDirectoryDialog();
    if (dir) {
      annotationTouchedRef.current = true;
      setAnnotationDir(trimProjectPrefix(projectDir, dir));
    }
  };

  const handleAnnotationChange = (v: string) => {
    annotationTouchedRef.current = true;
    setAnnotationDir(trimProjectPrefix(projectDir, v));
  };

  const handleCreate = async () => {
    if (!projectDir) { setError('Project directory is required.'); return; }
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!mediaDir) { setError('Media directory is required.'); return; }
    if (!annotationDir) { setError('Annotations directory is required.'); return; }

    setError('');
    setIsCreating(true);

    const projectDirOk = await checkDirExists(projectDir);
    if (!projectDirOk) { setError('Project directory does not exist.'); setIsCreating(false); return; }

    try {
      const existing = await readProjectSettings(projectDir);
      setExistingProjectName(existing.name);
      setError(`Project "${existing.name}" already exists in this location. Delete its .seenote directory first, or pick a different location.`);
      setIsCreating(false);
      return;
    } catch {
      setExistingProjectName(null);
    }

    try {
      await createDirAll(resolvedMediaDir);
      await createDirAll(resolvedAnnotationDir);

      const settings: ProjectSettings = {
        name: name.trim(),
        mediaDirectory: makeProjectPath(projectDir, resolvedMediaDir),
        annotationDirectory: makeProjectPath(projectDir, resolvedAnnotationDir),
        outputFormat: 'txt',
        annotationTools: DEFAULT_ANNOTATION_TOOLS,
        nameGradientColors: gradientColors,
      };
      const project = await createProject({ projectDir, settings });
      onCreated(project);
    } catch (err) {
      setError(String(err));
      setIsCreating(false);
    }
  };

  const mediaOutside = resolvedMediaDir && projectDir && !isInsideProjectDir(projectDir, resolvedMediaDir);
  const annotationOutside = resolvedAnnotationDir && projectDir && !isInsideProjectDir(projectDir, resolvedAnnotationDir);
  const mediaIsRelative = mediaDir && !isAbsolutePath(mediaDir);
  const annotationIsRelative = annotationDir && !isAbsolutePath(annotationDir);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-white text-lg font-semibold">Create New Project</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-sm block mb-1">Project Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectDir}
                onChange={e => { setProjectDir(e.target.value); setExistingProjectName(null); }}
                onBlur={e => checkExistingProject(e.target.value)}
                placeholder="/path/to/project"
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
              <p className="text-red-400 text-xs mt-1">
                Project "{existingProjectName}" already exists in this location. Delete its .seenote directory first, or pick a different location.
              </p>
            )}
          </div>

          <div>
            <label className="text-gray-400 text-sm block mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={e => { nameTouchedRef.current = true; setName(e.target.value); }}
              placeholder="My Project"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            {name.trim() && (
              <div className="mt-2 py-1">
                <span
                  className="text-xl font-bold bg-clip-text text-transparent"
                  style={{
                    backgroundImage: `linear-gradient(to right, ${gradientColors[0]}, ${gradientColors[1]})`,
                    display: 'inline-block',
                  }}
                >
                  {name.trim()}
                </span>
              </div>
            )}
            <div className="mt-3">
              <GradientPicker value={gradientColors} onChange={setGradientColors} />
            </div>
          </div>

          <div>
            <label className="text-gray-400 text-sm block mb-1">
              {mediaIsRelative ? 'Media Subdirectory' : 'Media Directory'}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={mediaDir}
                onChange={e => { mediaTouchedRef.current = true; setMediaDir(trimProjectPrefix(projectDir, e.target.value)); }}
                placeholder={projectDir ? 'media' : '/path/to/media'}
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleBrowseMedia}
                className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            {mediaIsRelative && resolvedMediaDir && (
              <p className="text-gray-500 text-xs mt-1">→ {resolvedMediaDir}</p>
            )}
            {mediaOutside && (
              <p className="text-yellow-400 text-xs mt-1">{PORTABILITY_WARNING}</p>
            )}
            {resolvedMediaDir && mediaDirExists === false && (
              <p className="text-yellow-400 text-xs mt-1">
                Directory does not exist yet; it will be created when the project is created.
              </p>
            )}
          </div>

          <div>
            <label className="text-gray-400 text-sm block mb-1">
              {annotationIsRelative ? 'Annotations Subdirectory' : 'Annotations Directory'}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={annotationDir}
                onChange={e => handleAnnotationChange(e.target.value)}
                placeholder={projectDir ? 'annotations' : '/path/to/annotations'}
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleBrowseAnnotation}
                className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            {annotationIsRelative && resolvedAnnotationDir && (
              <p className="text-gray-500 text-xs mt-1">→ {resolvedAnnotationDir}</p>
            )}
            {annotationOutside && (
              <p className="text-yellow-400 text-xs mt-1">{PORTABILITY_WARNING}</p>
            )}
            {resolvedAnnotationDir && annotationDirExists === false && (
              <p className="text-yellow-400 text-xs mt-1">
                Directory does not exist yet; it will be created when the project is created.
              </p>
            )}
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
          >
            {isCreating ? 'Creating…' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
