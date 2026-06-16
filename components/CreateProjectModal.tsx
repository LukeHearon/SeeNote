import React, { useState, useRef, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { Project, ProjectSettings } from '../types';
import { openDirectoryDialog, checkDirExists, createDirAll, createAnnotationTool, importAnnotationTools } from '../utils/tauriCommands';
import { readProjectSettings } from '../utils/projectCommands';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_TOOL_SEED, HOTKEY_COLORS, randomMagmaGradient } from '../constants';
import { buildHotkeyMap } from '../utils/annotationTools';
import { makeProjectPath, resolveInputPath } from '../utils/projectPaths';
import SettingsModalShell from './SettingsModalShell';
import ProjectBaseFields from './ProjectBaseFields';

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
  const [outputRoundingDecimals, setOutputRoundingDecimals] = useState(DEFAULT_OUTPUT_ROUNDING_DECIMALS);
  const [gradientColors, setGradientColors] = useState<[string, string]>(() => randomMagmaGradient());
  const [syncRemoteUrl, setSyncRemoteUrl] = useState('');
  const [syncToken, setSyncToken] = useState('');
  const [syncAuthorName, setSyncAuthorName] = useState('');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [existingProjectName, setExistingProjectName] = useState<string | null>(null);

  const nameTouchedRef = useRef(false);
  const mediaTouchedRef = useRef(false);
  const annotationTouchedRef = useRef(false);

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
        outputRoundingDecimals,
        toolHotkeys: buildHotkeyMap(DEFAULT_TOOL_SEED),
        customToolColor: DEFAULT_TOOL_SEED.find(t => t.key === '0')?.color ?? HOTKEY_COLORS[0],
        nameGradientColors: gradientColors,
        gitSync: (syncRemoteUrl.trim() || syncToken.trim() || syncAuthorName.trim())
          ? { remoteUrl: syncRemoteUrl.trim(), token: syncToken.trim(), authorName: syncAuthorName.trim() }
          : undefined,
      };
      const project = await createProject({ projectDir, settings });
      for (const t of DEFAULT_TOOL_SEED) {
        if (t.key === '0') continue;
        await createAnnotationTool(projectDir, t.text, t.color, t.description ?? '');
      }
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
      <SettingsModalShell
        title="Create New Project"
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {isCreating ? 'Creating…' : 'Create Project'}
            </button>
          </>
        }
      >
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

        <ProjectBaseFields
          projectDir={projectDir}
          name={name}
          onNameInput={n => { nameTouchedRef.current = true; setName(n); }}
          gradientColors={gradientColors}
          onGradientChange={setGradientColors}
          mediaDir={mediaDir}
          onMediaDirChange={v => { mediaTouchedRef.current = true; setMediaDir(v); }}
          mediaDirPlaceholder={projectDir ? 'media' : '/path/to/media'}
          mediaDirNotExistMessage="Directory does not exist yet; it will be created when the project is created."
          annotationDir={annotationDir}
          onAnnotationDirChange={v => { annotationTouchedRef.current = true; setAnnotationDir(v); }}
          annotationDirPlaceholder={projectDir ? 'annotations' : '/path/to/annotations'}
          annotationDirNotExistMessage="Directory does not exist yet; it will be created when the project is created."
          outputRoundingDecimals={outputRoundingDecimals}
          onOutputRoundingDecimalsChange={setOutputRoundingDecimals}
          buzzdetectDir={buzzdetectDir}
          onBuzzdetectDirChange={setBuzzdetectDir}
          toolsDir={toolsDir}
          onToolsDirChange={setToolsDir}
          toolsHelperText="Annotation tool folders ({label}/tool.json, description.txt, examples/) copied into the project on creation."
          syncRemoteUrl={syncRemoteUrl}
          onSyncRemoteUrlChange={setSyncRemoteUrl}
          syncToken={syncToken}
          onSyncTokenChange={setSyncToken}
          syncAuthorName={syncAuthorName}
          onSyncAuthorNameChange={setSyncAuthorName}
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </SettingsModalShell>
    </div>
  );
}
