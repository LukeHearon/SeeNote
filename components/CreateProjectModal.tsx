import React, { useState, useRef, useEffect } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { Project, ProjectSettings } from '../types';
import { openDirectoryDialog, checkDirExists, createDirAll, createAnnotationTool, importAnnotationTools } from '../utils/tauriCommands';
import { readProjectSettings } from '../utils/projectCommands';
import { DEFAULT_TOOL_SEED, HOTKEY_COLORS, randomMagmaGradient } from '../constants';
import { buildHotkeyMap } from '../utils/annotationTools';
import { makeProjectPath, resolveInputPath } from '../utils/projectPaths';
import GradientPicker from './GradientPicker';
import DirectoryField from './DirectoryField';
import CollapsibleSection from './CollapsibleSection';

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
  const [toolsDir, setToolsDir] = useState('');
  const [gradientColors, setGradientColors] = useState<[string, string]>(() => randomMagmaGradient());
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [existingProjectName, setExistingProjectName] = useState<string | null>(null);

  const nameTouchedRef = useRef(false);
  const mediaTouchedRef = useRef(false);
  const annotationTouchedRef = useRef(false);

  // Resolved absolute paths — used for all filesystem operations and settings serialisation.
  const resolvedMediaDir = resolveInputPath(projectDir, mediaDir);
  const resolvedAnnotationDir = resolveInputPath(projectDir, annotationDir);
  const resolvedBuzzdetectDir = resolveInputPath(projectDir, buzzdetectDir);
  const resolvedToolsDir = resolveInputPath(projectDir, toolsDir);

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
      setExistingProjectName(existing.name);
    } catch {
      setExistingProjectName(null);
    }
  };

  const handleBrowseProject = async () => {
    const dir = await openDirectoryDialog();
    if (dir) { setProjectDir(dir); checkExistingProject(dir); }
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
        buzzdetectDirectory: buzzdetectDir ? makeProjectPath(projectDir, resolvedBuzzdetectDir) : undefined,
        outputFormat: 'txt',
        toolHotkeys: buildHotkeyMap(DEFAULT_TOOL_SEED),
        customToolColor: DEFAULT_TOOL_SEED.find(t => t.key === '0')?.color ?? HOTKEY_COLORS[0],
        nameGradientColors: gradientColors,
      };
      const project = await createProject({ projectDir, settings });
      // createProject made .seenote/; seed a tool folder per non-Custom default
      // so a fresh project is usable out of the box.
      for (const t of DEFAULT_TOOL_SEED) {
        if (t.key === '0') continue;
        await createAnnotationTool(projectDir, t.text, t.color, t.description ?? '');
      }
      // Migrate an external tools directory (full {label}/tool.json +
      // examples/ structure) into the project, adding to the seeded tools.
      if (toolsDir) {
        await importAnnotationTools(projectDir, resolvedToolsDir, HOTKEY_COLORS.slice(1));
      }
      onCreated(project);
    } catch (err) {
      setError(String(err));
      setIsCreating(false);
    }
  };

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
              <div className="flex items-start gap-2 mt-1">
                <p className="text-red-400 text-xs flex-1">
                  Project "{existingProjectName}" already exists in this location. Delete its .seenote directory first, or pick a different location.
                </p>
                {onOpenExisting && (
                  <button
                    onClick={() => onOpenExisting(projectDir)}
                    className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-md transition-colors shrink-0"
                  >
                    Open Existing Project
                  </button>
                )}
              </div>
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

          <DirectoryField
            label="Media"
            projectDir={projectDir}
            value={mediaDir}
            onChange={v => { mediaTouchedRef.current = true; setMediaDir(v); }}
            placeholder={projectDir ? 'media' : '/path/to/media'}
            notExistMessage="Directory does not exist yet; it will be created when the project is created."
          />

          <DirectoryField
            label="Annotations"
            projectDir={projectDir}
            value={annotationDir}
            onChange={v => { annotationTouchedRef.current = true; setAnnotationDir(v); }}
            placeholder={projectDir ? 'annotations' : '/path/to/annotations'}
            notExistMessage="Directory does not exist yet; it will be created when the project is created."
          />

          <CollapsibleSection title="Advanced">
            <DirectoryField
              label="buzzdetect"
              projectDir={projectDir}
              value={buzzdetectDir}
              onChange={setBuzzdetectDir}
              placeholder="(optional) directory of {ident}_buzzdetect.csv"
              helperText="Activations plotted below the spectrogram, located per track by ident."
              notExistMessage="Directory does not exist."
            />
            <DirectoryField
              label="Tools"
              projectDir={projectDir}
              value={toolsDir}
              onChange={setToolsDir}
              placeholder="(optional) directory of {label}/ tool folders"
              helperText="Annotation tool folders ({label}/tool.json, description.txt, examples/) copied into the project on creation."
              notExistMessage="Directory does not exist."
            />
          </CollapsibleSection>

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
